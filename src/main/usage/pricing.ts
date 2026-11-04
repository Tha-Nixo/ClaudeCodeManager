/**
 * Anthropic API list rates in USD per MILLION tokens.
 *
 * Cache pricing is computed from multipliers on input price:
 *   cache read:           0.1x
 *   cache write (5 min):  1.25x
 *   cache write (1 hour): 2.0x
 *
 * NOTE: These are standard API list prices. For Max or Pro subscriptions,
 * the displayed cost is not actual billing but "what this would have cost via API".
 */

export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_5M_MULTIPLIER = 1.25
export const CACHE_WRITE_1H_MULTIPLIER = 2

export interface ModelPrice {
  /** Human-readable label for UI. */
  label: string
  /** USD per million input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
  /** Note displayed alongside price, e.g. introductory rates. */
  note?: string
}

/**
 * Keys ordered by specificity: exact match, then prefix, then family heuristic.
 */
export const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5': { label: 'Fable 5', input: 10, output: 50 },
  'claude-mythos-5': { label: 'Mythos 5', input: 10, output: 50 },
  'claude-opus-5': { label: 'Opus 5', input: 5, output: 25 },
  'claude-opus-4-8': { label: 'Opus 4.8', input: 5, output: 25 },
  'claude-opus-4-7': { label: 'Opus 4.7', input: 5, output: 25 },
  'claude-opus-4-6': { label: 'Opus 4.6', input: 5, output: 25 },
  'claude-opus-4-5': { label: 'Opus 4.5', input: 5, output: 25 },
  // Introductory pricing until 2026-08-31; afterwards 3 / 15.
  'claude-sonnet-5': {
    label: 'Sonnet 5',
    input: 2,
    output: 10,
    note: 'introductory pricing until 2026-08-31'
  },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', input: 3, output: 15 },
  'claude-sonnet-4-5': { label: 'Sonnet 4.5', input: 3, output: 15 },
  'claude-haiku-4-5': { label: 'Haiku 4.5', input: 1, output: 5 }
}

/**
 * Context window per model in tokens.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000
}

/** Fallback heuristic for unrecognized models in known families. */
const FAMILY_FALLBACK: { keyword: string; key: string }[] = [
  { keyword: 'fable', key: 'claude-fable-5' },
  { keyword: 'mythos', key: 'claude-mythos-5' },
  { keyword: 'opus', key: 'claude-opus-5' },
  { keyword: 'sonnet', key: 'claude-sonnet-5' },
  { keyword: 'haiku', key: 'claude-haiku-4-5' }
]

/**
 * Returns context window for a model, indicating whether it was inferred.
 * Returns 0 when completely unrecognized.
 */
export function contextWindowFor(model: string | null | undefined): {
  window: number
  approximate: boolean
} {
  if (!model) return { window: 0, approximate: false }
  const id = model.toLowerCase()

  const exact = CONTEXT_WINDOWS[id]
  if (exact) return { window: exact, approximate: false }

  for (const [key, window] of Object.entries(CONTEXT_WINDOWS)) {
    if (id.startsWith(key)) return { window, approximate: false }
  }

  for (const { keyword, key } of FAMILY_FALLBACK) {
    if (id.includes(keyword)) return { window: CONTEXT_WINDOWS[key] ?? 0, approximate: true }
  }
  return { window: 0, approximate: false }
}

export interface ResolvedPrice extends ModelPrice {
  /** True when price was resolved via family heuristic fallback. */
  approximate: boolean
}

export function priceFor(model: string | null | undefined): ResolvedPrice | null {
  if (!model) return null
  const id = model.toLowerCase()

  const exact = PRICING[id]
  if (exact) return { ...exact, approximate: false }

  for (const [key, value] of Object.entries(PRICING)) {
    if (id.startsWith(key)) return { ...value, approximate: false }
  }

  for (const { keyword, key } of FAMILY_FALLBACK) {
    if (id.includes(keyword)) return { ...PRICING[key], approximate: true }
  }

  return null
}

/** Checks whether a model is billable. */
export function isBillable(model: string | null | undefined): boolean {
  return priceFor(model) !== null
}

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  /** Cache creation tokens with 5-minute TTL. */
  cacheWrite5m: number
  /** Cache creation tokens with 1-hour TTL. */
  cacheWrite1h: number
}

export const ZERO_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h
  }
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
}

/** USD cost calculation for given token counts and model. */
export function costOf(model: string | null | undefined, tokens: TokenCounts): number {
  const price = priceFor(model)
  if (!price) return 0

  const perMillion =
    tokens.input * price.input +
    tokens.output * price.output +
    tokens.cacheRead * price.input * CACHE_READ_MULTIPLIER +
    tokens.cacheWrite5m * price.input * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheWrite1h * price.input * CACHE_WRITE_1H_MULTIPLIER

  return perMillion / 1_000_000
}
