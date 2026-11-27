import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { SessionUsage, UsageSummary } from '@shared/types'
import { projectsDir } from '../claude/paths'
import { readJson, writeJsonAtomic } from '../store/config'
import {
  PRICING_FINGERPRINT,
  ZERO_TOKENS,
  addTokens,
  contextWindowFor,
  costOf,
  isBillable,
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
 */

// Raise it whenever the cached data changes shape (4: last-turn fields; 5:
// per-turn costs, #16). The full rescan that follows happens once.
const CACHE_VERSION = 5

/** Tokens and their cost, for one model in one bucket (file or day). */
interface ModelUsage {
  tokens: TokenCounts
  cost: number
}

interface FileContribution {
  mtimeMs: number
  size: number
  sessionId: string
  cwd: string | null
  turns: number
  firstAt: number
  lastAt: number
  /** Usage per model: the price depends on the model, so models are never merged. */
  byModel: Record<string, ModelUsage>
  /** Usage per local day (YYYY-MM-DD) and model. */
  byDay: Record<string, Record<string, ModelUsage>>
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
  model: string | null
  tokens: TokenCounts
  cost: number
  timestamp: number
}

function addUsage(a: ModelUsage | undefined, turn: Turn): ModelUsage {
  return {
    tokens: addTokens(a?.tokens ?? ZERO_TOKENS, turn.tokens),
    cost: (a?.cost ?? 0) + turn.cost
  }
}

function parseTranscript(file: string): Omit<FileContribution, 'mtimeMs' | 'size'> {
  const contribution: Omit<FileContribution, 'mtimeMs' | 'size'> = {
    sessionId: basename(file, '.jsonl'),
    cwd: null,
    turns: 0,
    firstAt: 0,
    lastAt: 0,
    byModel: {},
    byDay: {},
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

  for (const line of raw.split('\n')) {
    if (!line.trim() || !line.includes('"usage"')) continue

    let rec: {
      type?: string
      cwd?: string
      timestamp?: string
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

    if (rec.type !== 'assistant') continue
    if (rec.cwd && !contribution.cwd) contribution.cwd = rec.cwd

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
    if (!isBillable(model)) continue

    const timestamp = rec.timestamp ? Date.parse(rec.timestamp) : 0
    const key = rec.message?.id
    const cost = costOf(model, tokens, {
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
      fast: usage.speed === 'fast',
      usOnly: usage.inference_geo === 'us'
    })
    const turn: Turn = { model, tokens, cost, timestamp }

    // File order, not timestamp order: the last turn written is the one that
    // describes the context now, and timestamps across subagents and the main
    // session are not necessarily monotonic.
    contribution.lastContext = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
    contribution.lastModel = model

    // Without a message.id there is no way to deduplicate: the turn is kept
    // anyway, under a unique key.
    byMessageId.set(key || `anon-${byMessageId.size}`, turn)
  }

  for (const turn of byMessageId.values()) {
    const model = turn.model ?? 'unknown'
    contribution.turns += 1
    contribution.byModel[model] = addUsage(contribution.byModel[model], turn)

    if (turn.timestamp > 0) {
      const day = localDayKey(new Date(turn.timestamp))
      contribution.byDay[day] ??= {}
      contribution.byDay[day][model] = addUsage(contribution.byDay[day][model], turn)
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

/**
 * Usage per session, indexed by sessionId.
 *
 * It feeds the monitor panel, which thinks per pane rather than per folder or
 * model like `summarize` does. The scan is the same: calling both in the same
 * round does not cost twice, because `scan` has its own minimum interval.
 */
export function sessionUsage(): Record<string, SessionUsage> {
  scan()
  const state = loadCache()
  const out: Record<string, SessionUsage> = {}

  for (const file of Object.values(state.files)) {
    let tokens = 0
    let cost = 0
    for (const usage of Object.values(file.byModel)) {
      tokens += totalTokens(usage.tokens)
      cost += usage.cost
    }

    const { window, approximate } = contextWindowFor(file.lastModel)

    // A subagent has its own transcript, and its id does not exist elsewhere, so
    // the map has no collisions: one entry per file.
    out[file.sessionId] = {
      sessionId: file.sessionId,
      cwd: file.cwd,
      turns: file.turns,
      tokens,
      cost,
      lastAt: file.lastAt,
      contextTokens: file.lastContext,
      contextWindow: window,
      contextApproximate: approximate,
      model: file.lastModel
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
  const state = loadCache()

  const today = dayKey(0)
  const last7 = new Set(Array.from({ length: 7 }, (_, i) => dayKey(i)))

  let todayCost = 0
  let weekCost = 0
  let totalCost = 0
  let todayTokens = 0
  let weekTokens = 0
  let totalTokensAll = 0
  let sessions = 0

  const byModel: Record<string, { tokens: number; cost: number }> = {}
  const byProject: Record<string, { tokens: number; cost: number }> = {}

  for (const contribution of Object.values(state.files)) {
    if (contribution.turns === 0) continue
    sessions += 1

    const project = contribution.cwd ?? 'unknown'

    for (const [model, usage] of Object.entries(contribution.byModel)) {
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
    }

    for (const [day, models] of Object.entries(contribution.byDay)) {
      for (const usage of Object.values(models)) {
        const cost = usage.cost
        const count = totalTokens(usage.tokens)
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
    totalTokens: totalTokensAll,
    sessions,
    byModel: Object.entries(byModel)
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost),
    byProject: Object.entries(byProject)
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 12),
    generatedAt: Date.now()
  }
}
