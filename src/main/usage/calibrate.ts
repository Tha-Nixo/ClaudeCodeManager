import { ZERO_TOKENS, addTokens, type TokenCounts } from './pricing'

/**
 * Calibration with Claude Code's own cost records (#25).
 *
 * Claude Code writes `type: "cost-state"` records into each session's main
 * transcript: cumulative totals per model, the figures `/cost` shows. They know
 * things the transcripts do not:
 *
 * - background calls that never appear as assistant records (on the machine
 *   the checkup ran on, almost all Haiku 5.5 cost, and all of Opus 5's);
 * - the price of a model the table has never heard of;
 * - what older Claude Code versions charged at the time.
 *
 * But they are sparse (6 in a 787-turn session) and carry no timestamp, so
 * they cannot replace the per-turn scan: "today" and "last 7 days" need turns.
 * So the snapshot calibrates the turns instead of replacing them. For each
 * model, the turns before the last snapshot are scaled so that they add up to
 * what the snapshot reports. A model with no visible turn at all gets one
 * synthetic bucket on the snapshot's day. Turns after the snapshot keep their
 * table price and count as estimated until the next snapshot.
 *
 * Turns after a snapshot are not scaled by the latest factor: for a model used
 * mostly in the background the factor is in the hundreds, and multiplying the
 * next visible turn by it would be a guess presented as a fact.
 */

/** Tokens and their cost, for one model in one bucket. */
export interface ModelUsage {
  tokens: TokenCounts
  cost: number
}

/** Usage by local day ('' when a turn had no timestamp) and model. */
export type DayBuckets = Record<string, Record<string, ModelUsage>>

/** The last `cost-state` record of a session, as `/cost` would show it. */
export interface CostSnapshot {
  /** Timestamp of the last record before it: cost-state has none of its own. */
  at: number
  models: Record<string, ModelUsage>
}

/** One transcript of a session: the main one, or a subagent's. */
export interface SessionPart {
  /** Only the main transcript carries snapshots. */
  snapshot: CostSnapshot | null
  /** Main transcript: turns written before the last snapshot. */
  before: DayBuckets
  /** Turns after it, or every turn when the transcript has no snapshot. */
  after: DayBuckets
  firstAt: number
  lastAt: number
}

export interface CalibratedSession {
  byDay: DayBuckets
  cost: number
  /** The part of `cost` that comes from Claude Code's own records. */
  reportedCost: number
}

export function addUsage(a: ModelUsage | undefined, b: ModelUsage): ModelUsage {
  return {
    tokens: addTokens(a?.tokens ?? ZERO_TOKENS, b.tokens),
    cost: (a?.cost ?? 0) + b.cost
  }
}

function addInto(target: DayBuckets, day: string, model: string, usage: ModelUsage): void {
  target[day] ??= {}
  target[day][model] = addUsage(target[day][model], usage)
}

function each(buckets: DayBuckets, fn: (day: string, model: string, usage: ModelUsage) => void): void {
  for (const [day, models] of Object.entries(buckets)) {
    for (const [model, usage] of Object.entries(models)) fn(day, model, usage)
  }
}

/**
 * Merges the transcripts of one session and calibrates them with the main
 * transcript's last snapshot, if it has one.
 *
 * `dayOf` turns the snapshot's timestamp into a day key: it is passed in so the
 * caller decides the time zone (the scanner uses the local one).
 */
export function calibrateSession(
  parts: SessionPart[],
  dayOf: (at: number) => string
): CalibratedSession {
  const snapshot = parts.find((p) => p.snapshot)?.snapshot ?? null
  const byDay: DayBuckets = {}

  if (!snapshot) {
    let cost = 0
    for (const p of parts) {
      for (const buckets of [p.before, p.after]) {
        each(buckets, (day, model, usage) => {
          addInto(byDay, day, model, usage)
          cost += usage.cost
        })
      }
    }
    return { byDay, cost, reportedCost: 0 }
  }

  // A subagent transcript has no snapshot of its own: it counts as before the
  // snapshot when it started before it. Subagents are short-lived, and the
  // snapshot covers them, so the rare one that straddles it is counted once,
  // on the side where it started.
  const before: DayBuckets = {}
  const after: DayBuckets = {}
  for (const p of parts) {
    const isMain = p.snapshot !== null
    const subagentBefore = !isMain && p.firstAt > 0 && p.firstAt <= snapshot.at
    each(p.before, (day, model, usage) => addInto(before, day, model, usage))
    each(p.after, (day, model, usage) =>
      addInto(subagentBefore ? before : after, day, model, usage)
    )
  }

  const visible: Record<string, number> = {}
  each(before, (_day, model, usage) => {
    visible[model] = (visible[model] ?? 0) + usage.cost
  })

  let cost = 0
  let reportedCost = 0
  each(before, (day, model, usage) => {
    const reported = snapshot.models[model]
    const factor = reported && visible[model] > 0 ? reported.cost / visible[model] : 1
    const scaled = { tokens: usage.tokens, cost: usage.cost * factor }
    addInto(byDay, day, model, scaled)
    cost += scaled.cost
    if (reported) reportedCost += scaled.cost
  })

  // Models the snapshot reports but no transcript shows: background calls, or
  // a model the price table cannot price. They land on the snapshot's day.
  for (const [model, reported] of Object.entries(snapshot.models)) {
    if ((visible[model] ?? 0) > 0 || reported.cost <= 0) continue
    addInto(byDay, snapshot.at > 0 ? dayOf(snapshot.at) : '', model, reported)
    cost += reported.cost
    reportedCost += reported.cost
  }

  each(after, (day, model, usage) => {
    addInto(byDay, day, model, usage)
    cost += usage.cost
  })

  return { byDay, cost, reportedCost }
}

interface RawModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  cacheCreationEphemeral5mInputTokens?: number
  cacheCreationEphemeral1hInputTokens?: number
  costUSD?: number
}

/**
 * Reads the models of a `cost-state` record. Two layouts exist: older Claude
 * Code versions write one `cacheCreationInputTokens` total (5-minute writes),
 * newer ones split it into 5m and 1h.
 */
export function snapshotModels(modelUsage: unknown): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {}
  if (!modelUsage || typeof modelUsage !== 'object') return out
  for (const [model, raw] of Object.entries(modelUsage as Record<string, RawModelUsage>)) {
    if (!raw || typeof raw !== 'object' || typeof raw.costUSD !== 'number') continue
    if (!Number.isFinite(raw.costUSD) || raw.costUSD < 0) continue
    const split = raw.cacheCreationEphemeral1hInputTokens !== undefined
    out[model] = {
      cost: raw.costUSD,
      tokens: {
        input: raw.inputTokens ?? 0,
        output: raw.outputTokens ?? 0,
        cacheRead: raw.cacheReadInputTokens ?? 0,
        cacheWrite5m: split
          ? (raw.cacheCreationEphemeral5mInputTokens ?? 0)
          : (raw.cacheCreationInputTokens ?? 0),
        cacheWrite1h: split ? (raw.cacheCreationEphemeral1hInputTokens ?? 0) : 0
      }
    }
  }
  return out
}
