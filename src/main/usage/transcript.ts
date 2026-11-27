import { addUsage, snapshotModels, type CostSnapshot, type DayBuckets } from './calibrate'
import { costOf, isBillable, type TokenCounts } from './pricing'

/**
 * Reads a Claude Code transcript one line at a time.
 *
 * The local scanner feeds it whole files; a remote session (#26) feeds it the
 * lines that arrive over ssh as the transcript grows. One parser for both, so a
 * remote pane's cost and context fill are computed exactly like a local one's.
 */

export interface ParsedTranscript {
  /**
   * The session the transcript belongs to, from its records. A subagent's
   * records carry the parent session's id. Null when no record says.
   */
  ownerSessionId: string | null
  cwd: string | null
  turns: number
  firstAt: number
  lastAt: number
  /** The last `cost-state` record. */
  snapshot: CostSnapshot | null
  /** Turns written before the last snapshot (none without a snapshot). */
  before: DayBuckets
  /** Turns after the last snapshot, or every turn without one. */
  after: DayBuckets
  /** Input tokens of the latest turn, cache included: the current context size. */
  lastContext: number
  lastModel: string | null
}

interface Turn {
  model: string
  tokens: TokenCounts
  cost: number
  timestamp: number
  /** Line of the record that last wrote this turn: places it around a snapshot. */
  line: number
}

interface TranscriptRecord {
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

export class TranscriptReader {
  // Deduplicate within the file: several records share the same message.id and
  // only the last one carries the final totals. Summing them all inflates the
  // numbers.
  private byMessageId = new Map<string, Turn>()
  private owner: string | null = null
  private cwd: string | null = null
  private snapshot: CostSnapshot | null = null
  private snapshotLine = -1
  private lastTimestamp = 0
  private lastContext = 0
  private lastModel: string | null = null
  private anonymous = 0
  private line = 0

  /** @param dayOf day key for a timestamp, in the time zone the totals use */
  constructor(private readonly dayOf: (at: number) => string) {}

  push(text: string): void {
    const index = this.line++
    const isSnapshot = text.includes('"cost-state"')
    if (!text.trim() || (!isSnapshot && !text.includes('"usage"'))) return

    let rec: TranscriptRecord
    try {
      rec = JSON.parse(text)
    } catch {
      // A line cut by a crash, or read while Claude Code is writing it.
      return
    }

    // Cumulative for the session: only the last one matters. It has no
    // timestamp, so it takes the one of the last turn written before it.
    if (rec.type === 'cost-state') {
      this.snapshot = { at: this.lastTimestamp, models: snapshotModels(rec.modelUsage) }
      this.snapshotLine = index
      return
    }

    if (rec.type !== 'assistant') return
    if (rec.cwd && !this.cwd) this.cwd = rec.cwd
    if (!this.owner && typeof rec.sessionId === 'string' && rec.sessionId) this.owner = rec.sessionId

    const usage = rec.message?.usage
    if (!usage) return

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
    if (sum === 0) return

    const model = rec.message?.model ?? null
    if (!model || !isBillable(model)) return

    const timestamp = rec.timestamp ? Date.parse(rec.timestamp) : 0
    if (timestamp > 0) this.lastTimestamp = timestamp
    const cost = costOf(model, tokens, {
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
      fast: usage.speed === 'fast',
      usOnly: usage.inference_geo === 'us'
    })

    // File order, not timestamp order: the last turn written is the one that
    // describes the context now, and timestamps across subagents and the main
    // session are not necessarily monotonic.
    this.lastContext = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
    this.lastModel = model

    // Without a message.id there is no way to deduplicate: the turn is kept
    // anyway, under a unique key.
    const key = rec.message?.id || `anon-${this.anonymous++}`
    this.byMessageId.set(key, { model, tokens, cost, timestamp, line: index })
  }

  result(): ParsedTranscript {
    const out: ParsedTranscript = {
      ownerSessionId: this.owner,
      cwd: this.cwd,
      turns: 0,
      firstAt: 0,
      lastAt: 0,
      snapshot: this.snapshot,
      before: {},
      after: {},
      lastContext: this.lastContext,
      lastModel: this.lastModel
    }

    for (const turn of this.byMessageId.values()) {
      out.turns += 1
      const side = turn.line < this.snapshotLine ? out.before : out.after
      const day = turn.timestamp > 0 ? this.dayOf(turn.timestamp) : ''
      side[day] ??= {}
      side[day][turn.model] = addUsage(side[day][turn.model], turn)

      if (turn.timestamp > 0) {
        out.firstAt = out.firstAt === 0 ? turn.timestamp : Math.min(out.firstAt, turn.timestamp)
        out.lastAt = Math.max(out.lastAt, turn.timestamp)
      }
    }
    return out
  }
}
