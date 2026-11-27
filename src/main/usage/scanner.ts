import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { SessionUsage, UsageSummary } from '@shared/types'
import { projectsDir } from '../claude/paths'
import { readJson, writeJsonAtomic } from '../store/config'
import {
  addUsage,
  calibrateSession,
  snapshotModels,
  type CostSnapshot,
  type DayBuckets
} from './calibrate'
import {
  PRICING_FINGERPRINT,
  contextWindowFor,
  costOf,
  isBillable,
  priceFor,
  totalTokens,
  type TokenCounts
} from './pricing'

/**
 * Token accounting from Claude Code transcripts.
 *
 * The unit of incrementality is the FILE, not the line. When a transcript
 * changes it is read again in full and its contribution replaced.
 *
 * It looks more expensive than resuming from the last line read, but it avoids
 * a concrete error: Claude Code writes SEVERAL lines with the same `message.id`
 * for the same API response, and the last one wins. Resuming halfway through
 * the file, a line already counted that shows up again later would be added
 * twice. Reading the whole file keeps deduplication by message.id always
 * correct, and in steady state only the active session's transcript changes.
 *
 * Costs are computed per turn while parsing, not from summed tokens: a price
 * can depend on the size of each request (Haiku 5.5 charges more above 100K
 * prompt tokens), and summed tokens no longer know which request was which.
 * The cache therefore stores costs, and it is rebuilt whenever the price table
 * changes (`PRICING_FINGERPRINT`).
 *
 * The figures shown are then calibrated, per session, with the `cost-state`
 * records Claude Code writes itself (#25, see calibrate.ts). Calibration runs
 * when the totals are asked for, not here: a session's subagent transcripts are
 * separate files, cached separately, and only the whole session can be
 * compared with its snapshot.
 */

// Raise it whenever the cached data changes shape (4: last-turn fields; 5:
// per-turn costs, #16; 6: snapshots and the before/after split, #25). The
// full rescan that follows happens once.
const CACHE_VERSION = 6

interface FileContribution {
  mtimeMs: number
  size: number
  /** The file's own name: the session id, or `agent-…` for a subagent. */
  sessionId: string
  /**
   * The session this transcript belongs to. A subagent's records carry the
   * parent session's id, and `/cost` counts subagents with their parent.
   */
  ownerSessionId: string
  cwd: string | null
  turns: number
  firstAt: number
  lastAt: number
  /** The last `cost-state` record, main transcripts only. */
  snapshot: CostSnapshot | null
  /** Turns written before the last snapshot (none without a snapshot). */
  before: DayBuckets
  /** Turns after the last snapshot, or every turn without one. */
  after: DayBuckets
  /**
   * Input tokens of the LATEST assistant turn, cache included.
   *
   * It approximates how full the context is now: every request sends the whole
   * conversation again, so the last turn's input is the current size of the
   * conversation. `input_tokens` alone is not enough: it is only the part NOT
   * served from the cache, and in a long session that is the minority.
   */
  lastContext: number
  /** Model of the latest turn, to know which window to measure it against. */
  lastModel: string | null
}

interface UsageCache {
  version: number
  /** PRICING_FINGERPRINT of the table the stored costs were computed with. */
  pricing: string
  files: Record<string, FileContribution>
}

let cache: UsageCache | null = null
let lastScan = 0
const MIN_RESCAN_MS = 2_000

function cachePath(): string {
  return join(app.getPath('userData'), 'usage-cache.json')
}

function loadCache(): UsageCache {
  if (cache) return cache
  const stored = readJson<UsageCache>(cachePath())
  const current =
    stored && stored.version === CACHE_VERSION && stored.pricing === PRICING_FINGERPRINT
  cache = current ? stored : { version: CACHE_VERSION, pricing: PRICING_FINGERPRINT, files: {} }
  return cache
}

/** Every transcript, including the subagents' ones in subfolders. */
function findTranscripts(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) findTranscripts(full, out)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

interface Turn {
  model: string
  tokens: TokenCounts
  cost: number
  timestamp: number
  /** Line of the record that last wrote this turn: places it around a snapshot. */
  line: number
}

function parseTranscript(file: string): Omit<FileContribution, 'mtimeMs' | 'size'> {
  const contribution: Omit<FileContribution, 'mtimeMs' | 'size'> = {
    sessionId: basename(file, '.jsonl'),
    ownerSessionId: basename(file, '.jsonl'),
    cwd: null,
    turns: 0,
    firstAt: 0,
    lastAt: 0,
    snapshot: null,
    before: {},
    after: {},
    lastContext: 0,
    lastModel: null
  }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return contribution
  }

  // Deduplicate within the file: several records share the same message.id and
  // only the last one carries the final totals. Summing them all inflates the
  // numbers.
  const byMessageId = new Map<string, Turn>()
  let owner: string | null = null
  let snapshotLine = -1
  let lastTimestamp = 0

  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const isSnapshot = line.includes('"cost-state"')
    if (!line.trim() || (!isSnapshot && !line.includes('"usage"'))) continue

    let rec: {
      type?: string
      cwd?: string
      sessionId?: string
      timestamp?: string
      modelUsage?: unknown
      message?: {
        id?: string
        model?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          cache_creation?: {
            ephemeral_5m_input_tokens?: number
            ephemeral_1h_input_tokens?: number
          }
          server_tool_use?: { web_search_requests?: number }
          speed?: string
          inference_geo?: string
        }
      }
    }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }

    // Cumulative for the session: only the last one matters. It has no
    // timestamp, so it takes the one of the last turn written before it.
    if (rec.type === 'cost-state') {
      contribution.snapshot = { at: lastTimestamp, models: snapshotModels(rec.modelUsage) }
      snapshotLine = index
      continue
    }

    if (rec.type !== 'assistant') continue
    if (rec.cwd && !contribution.cwd) contribution.cwd = rec.cwd
    if (!owner && typeof rec.sessionId === 'string' && rec.sessionId) owner = rec.sessionId

    const usage = rec.message?.usage
    if (!usage) continue

    const created = usage.cache_creation
    const creationTotal = usage.cache_creation_input_tokens ?? 0
    // The 5m/1h split is authoritative when present; otherwise everything is
    // attributed to 5 minutes, the default TTL.
    const write5m = created?.ephemeral_5m_input_tokens ?? (created ? 0 : creationTotal)
    const write1h = created?.ephemeral_1h_input_tokens ?? 0

    const tokens: TokenCounts = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h
    }

    const sum =
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
    if (sum === 0) continue

    const model = rec.message?.model ?? null
    if (!model || !isBillable(model)) continue

    const timestamp = rec.timestamp ? Date.parse(rec.timestamp) : 0
    if (timestamp > 0) lastTimestamp = timestamp
    const key = rec.message?.id
    const cost = costOf(model, tokens, {
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
      fast: usage.speed === 'fast',
      usOnly: usage.inference_geo === 'us'
    })
    const turn: Turn = { model, tokens, cost, timestamp, line: index }

    // File order, not timestamp order: the last turn written is the one that
    // describes the context now, and timestamps across subagents and the main
    // session are not necessarily monotonic.
    contribution.lastContext = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
    contribution.lastModel = model

    // Without a message.id there is no way to deduplicate: the turn is kept
    // anyway, under a unique key.
    byMessageId.set(key || `anon-${byMessageId.size}`, turn)
  }

  if (owner) contribution.ownerSessionId = owner

  for (const turn of byMessageId.values()) {
    contribution.turns += 1
    const side = turn.line < snapshotLine ? contribution.before : contribution.after
    const day = turn.timestamp > 0 ? localDayKey(new Date(turn.timestamp)) : ''
    side[day] ??= {}
    side[day][turn.model] = addUsage(side[day][turn.model], turn)

    if (turn.timestamp > 0) {
      contribution.firstAt =
        contribution.firstAt === 0
          ? turn.timestamp
          : Math.min(contribution.firstAt, turn.timestamp)
      contribution.lastAt = Math.max(contribution.lastAt, turn.timestamp)
    }
  }

  return contribution
}

/** Updates the cache by reading only the transcripts that changed. */
export function scan(force = false): void {
  if (!force && Date.now() - lastScan < MIN_RESCAN_MS) return
  lastScan = Date.now()

  const state = loadCache()
  const dir = projectsDir()
  if (!existsSync(dir)) return

  const files = findTranscripts(dir)
  const present = new Set(files)
  let changed = false

  for (const file of files) {
    let stat: import('node:fs').Stats
    try {
      stat = statSync(file)
    } catch {
      continue
    }

    const known = state.files[file]
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue

    state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, ...parseTranscript(file) }
    changed = true
  }

  // Deleted transcripts: their contribution is removed.
  //
  // A deliberate difference from claude-usage, which accumulates forever: on
  // the development machine its database held 5 transcripts that no longer
  // existed, 412 turns and 345k output tokens it kept adding up. Here the
  // numbers describe the transcripts that really exist, so they stay
  // checkable, and Claude Code's periodic cleanup does not inflate them.
  for (const known of Object.keys(state.files)) {
    if (!present.has(known)) {
      delete state.files[known]
      changed = true
    }
  }

  if (changed) writeJsonAtomic(cachePath(), state)
}

/** One session as the totals see it: its transcripts merged and calibrated. */
interface SessionTotals {
  id: string
  /** The main transcript, when it is still on disk. */
  main: FileContribution | null
  files: FileContribution[]
  byDay: DayBuckets
  cost: number
  reportedCost: number
  turns: number
}

/** Groups transcripts by session and calibrates each session (#25). */
function sessions(): SessionTotals[] {
  const groups = new Map<string, FileContribution[]>()
  for (const file of Object.values(loadCache().files)) {
    const list = groups.get(file.ownerSessionId) ?? []
    list.push(file)
    groups.set(file.ownerSessionId, list)
  }

  const out: SessionTotals[] = []
  for (const [id, files] of groups) {
    const calibrated = calibrateSession(files, (at) => localDayKey(new Date(at)))
    out.push({
      id,
      main: files.find((f) => f.sessionId === id) ?? null,
      files,
      ...calibrated,
      turns: files.reduce((n, f) => n + f.turns, 0)
    })
  }
  return out
}

/**
 * Usage per session, indexed by sessionId.
 *
 * It feeds the monitor panel, which thinks per pane rather than per folder or
 * model like `summarize` does. The scan is the same: calling both in the same
 * round does not cost twice, because `scan` has its own minimum interval.
 */
export function sessionUsage(): Record<string, SessionUsage> {
  scan()
  const out: Record<string, SessionUsage> = {}

  for (const session of sessions()) {
    let tokens = 0
    for (const models of Object.values(session.byDay)) {
      for (const usage of Object.values(models)) tokens += totalTokens(usage.tokens)
    }

    // The context is the main conversation's: a subagent's last turn says how
    // full ITS context is, not the pane's.
    const latest =
      session.main ??
      session.files.reduce((a, b) => (b.lastAt > a.lastAt ? b : a), session.files[0])
    const { window, approximate } = contextWindowFor(latest.lastModel)

    // Subagents are counted with their session, as /cost does: one entry per
    // session, keyed by the id the pane knows.
    out[session.id] = {
      sessionId: session.id,
      cwd: session.main?.cwd ?? session.files.find((f) => f.cwd)?.cwd ?? null,
      turns: session.turns,
      tokens,
      cost: session.cost,
      reportedCost: session.reportedCost,
      lastAt: Math.max(...session.files.map((f) => f.lastAt)),
      contextTokens: latest.lastContext,
      contextWindow: window,
      contextApproximate: approximate,
      model: latest.lastModel
    }
  }

  return out
}

/**
 * Day key in the user's time zone, not Greenwich's.
 *
 * `toISOString()` gave the UTC day: for someone in Italy, work done between
 * midnight and two in the morning was counted in the previous day, and
 * "Today", the most visible number in the app, said something other than what
 * the user had just done. In negative time zones the opposite happened. The key
 * keeps the YYYY-MM-DD shape, so comparisons and sorting do not change.
 */
function localDayKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function dayKey(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return localDayKey(d)
}

export function summarize(): UsageSummary {
  scan()

  const today = dayKey(0)
  const last7 = new Set(Array.from({ length: 7 }, (_, i) => dayKey(i)))

  let todayCost = 0
  let weekCost = 0
  let totalCost = 0
  let reportedCost = 0
  let todayTokens = 0
  let weekTokens = 0
  let totalTokensAll = 0
  let sessionCount = 0

  const byModel: Record<string, { tokens: number; cost: number }> = {}
  const byProject: Record<string, { tokens: number; cost: number }> = {}

  for (const session of sessions()) {
    if (session.turns === 0 && session.cost === 0) continue
    sessionCount += 1
    reportedCost += session.reportedCost

    const project = session.main?.cwd ?? session.files.find((f) => f.cwd)?.cwd ?? 'unknown'

    for (const [day, models] of Object.entries(session.byDay)) {
      for (const [model, usage] of Object.entries(models)) {
        const cost = usage.cost
        const count = totalTokens(usage.tokens)

        totalCost += cost
        totalTokensAll += count

        byModel[model] ??= { tokens: 0, cost: 0 }
        byModel[model].tokens += count
        byModel[model].cost += cost

        byProject[project] ??= { tokens: 0, cost: 0 }
        byProject[project].tokens += count
        byProject[project].cost += cost

        if (day === today) {
          todayCost += cost
          todayTokens += count
        }
        if (last7.has(day)) {
          weekCost += cost
          weekTokens += count
        }
      }
    }
  }

  return {
    todayCost,
    todayTokens,
    weekCost,
    weekTokens,
    totalCost,
    reportedCost,
    totalTokens: totalTokensAll,
    sessions: sessionCount,
    byModel: Object.entries(byModel)
      .map(([model, v]) => ({ model, ...v, approximate: priceFor(model)?.approximate ?? false }))
      .sort((a, b) => b.cost - a.cost),
    byProject: Object.entries(byProject)
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 12),
    generatedAt: Date.now()
  }
}
