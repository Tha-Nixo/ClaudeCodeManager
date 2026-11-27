/**
 * Anthropic API list prices, in USD per MILLION tokens.
 *
 * Every row is copied from https://platform.claude.com/docs/en/about-claude/pricing
 * and keeps the page's column order: base input, 5-minute cache write, 1-hour
 * cache write, cache hit, output. Copy new rows from the page on the day of the
 * change, never from memory: issue #16 is what happens otherwise. The cache-hit
 * price is NOT a fixed fraction of input (0.1x on most models, 0.05x on Opus 5.5
 * and Sonnet 5.5, 0.025x on Fable 5.1 / 5.2), which is why each row states all
 * five rates instead of deriving them from the input price.
 *
 * Last checked against the pricing page: 2026-11-27.
 *
 * NOTE: these are API list prices. With a Max or Pro subscription the figure
 * is not what you pay, but what the same tokens would have cost via the API.
 */

/** Rates in USD per million tokens, for one request. */
export interface Rates {
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
}

export interface ModelPrice {
  /** Human-readable label for the UI. */
  label: string
  rates: Rates
  /**
   * Higher rates for a request whose prompt is over `over` tokens (Haiku 5.5).
   * The pricing page counts "all of its input tokens, including cache reads and
   * cache writes", and prices each request on its own.
   */
  longPrompt?: { over: number; rates: Rates }
  /**
   * Fast mode input/output prices. The pricing page lists only these two;
   * "Prompt caching multipliers apply on top of fast mode pricing", so cache
   * rates scale by the same factor as input.
   */
  fast?: { input: number; output: number }
  /**
   * Claude 4.6 and later charge 1.1x on every category for US-only inference
   * (`inference_geo: "us"`). Earlier models reject the parameter.
   */
  dataResidency: boolean
  /** Context window in tokens. */
  context: number
}

/** Web search: $10 per 1,000 searches, on top of the tokens. */
export const WEB_SEARCH_USD = 10 / 1000

/** Multiplier for US-only inference on models with `dataResidency`. */
export const DATA_RESIDENCY_MULTIPLIER = 1.1

/** One row of the pricing page, in the page's column order. */
function row(
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number
): Rates {
  return { input, cacheWrite5m, cacheWrite1h, cacheRead, output }
}

const M = 1_000_000
const K200 = 200_000

/**
 * Keyed by the API model id. Ids carrying a date suffix (`-YYYYMMDD`) resolve
 * to the undated key; nothing else is matched by prefix, because a prefix match
 * is how `claude-opus-5-5` came to be priced as Opus 5 (#16).
 */
export const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5-2': {
    label: 'Fable 5.2',
    rates: row(8, 10, 16, 0.2, 40),
    fast: { input: 16, output: 80 },
    dataResidency: true,
    context: M
  },
  'claude-mythos-5-2': {
    label: 'Mythos 5.2',
    rates: row(8, 10, 16, 0.2, 40),
    fast: { input: 16, output: 80 },
    dataResidency: true,
    context: M
  },
  'claude-fable-5-1': {
    label: 'Fable 5.1',
    rates: row(10, 12.5, 20, 0.25, 50),
    dataResidency: true,
    context: M
  },
  'claude-mythos-5-1': {
    label: 'Mythos 5.1',
    rates: row(10, 12.5, 20, 0.25, 50),
    dataResidency: true,
    context: M
  },
  'claude-fable-5': {
    label: 'Fable 5',
    rates: row(10, 12.5, 20, 1, 50),
    dataResidency: true,
    context: M
  },
  'claude-mythos-5': {
    label: 'Mythos 5',
    rates: row(10, 12.5, 20, 1, 50),
    dataResidency: true,
    context: M
  },
  'claude-opus-5-5': {
    label: 'Opus 5.5',
    rates: row(4, 5, 8, 0.2, 20),
    fast: { input: 8, output: 40 },
    dataResidency: true,
    context: M
  },
  'claude-opus-5': {
    label: 'Opus 5',
    rates: row(5, 6.25, 10, 0.5, 25),
    fast: { input: 10, output: 50 },
    dataResidency: true,
    context: M
  },
  'claude-opus-4-8': {
    label: 'Opus 4.8',
    rates: row(5, 6.25, 10, 0.5, 25),
    fast: { input: 10, output: 50 },
    dataResidency: true,
    context: M
  },
  'claude-opus-4-7': {
    label: 'Opus 4.7',
    rates: row(5, 6.25, 10, 0.5, 25),
    dataResidency: true,
    context: M
  },
  'claude-opus-4-6': {
    label: 'Opus 4.6',
    rates: row(5, 6.25, 10, 0.5, 25),
    dataResidency: true,
    context: M
  },
  'claude-opus-4-5': {
    label: 'Opus 4.5',
    rates: row(5, 6.25, 10, 0.5, 25),
    dataResidency: false,
    context: K200
  },
  'claude-opus-4-1': {
    label: 'Opus 4.1',
    rates: row(15, 18.75, 30, 1.5, 75),
    dataResidency: false,
    context: K200
  },
  'claude-opus-4': {
    label: 'Opus 4',
    rates: row(15, 18.75, 30, 1.5, 75),
    dataResidency: false,
    context: K200
  },
  'claude-sonnet-5-5': {
    label: 'Sonnet 5.5',
    rates: row(2, 2.5, 4, 0.1, 10),
    dataResidency: true,
    context: M
  },
  // Launched with "introductory" $2/$10 pricing; the page now says it "is now
  // the standard price" and the increase to $3/$15 "will not occur".
  'claude-sonnet-5': {
    label: 'Sonnet 5',
    rates: row(2, 2.5, 4, 0.2, 10),
    dataResidency: true,
    context: M
  },
  'claude-sonnet-4-6': {
    label: 'Sonnet 4.6',
    rates: row(3, 3.75, 6, 0.3, 15),
    dataResidency: true,
    context: M
  },
  'claude-sonnet-4-5': {
    label: 'Sonnet 4.5',
    rates: row(3, 3.75, 6, 0.3, 15),
    dataResidency: false,
    context: K200
  },
  'claude-sonnet-4': {
    label: 'Sonnet 4',
    rates: row(3, 3.75, 6, 0.3, 15),
    dataResidency: false,
    context: K200
  },
  'claude-haiku-5-5': {
    label: 'Haiku 5.5',
    rates: row(0.1, 0.125, 0.2, 0.01, 0.5),
    longPrompt: { over: 100_000, rates: row(0.5, 0.625, 1, 0.05, 2.5) },
    dataResidency: true,
    context: M
  },
  'claude-haiku-4-5': {
    label: 'Haiku 4.5',
    rates: row(1, 1.25, 2, 0.1, 5),
    dataResidency: false,
    context: K200
  }
}

/**
 * Unknown ids of a known family are priced as the newest model of that family
 * and always flagged approximate: a guess must never look like a fact.
 */
const FAMILY_FALLBACK: { keyword: string; key: string }[] = [
  { keyword: 'fable', key: 'claude-fable-5-2' },
  { keyword: 'mythos', key: 'claude-mythos-5-2' },
  { keyword: 'opus', key: 'claude-opus-5-5' },
  { keyword: 'sonnet', key: 'claude-sonnet-5-5' },
  { keyword: 'haiku', key: 'claude-haiku-5-5' }
]

const DATE_SUFFIX = /-\d{8}$/

export interface ResolvedPrice extends ModelPrice {
  /** The PRICING key the id resolved to. */
  key: string
  /** True when resolved by family fallback rather than by id. */
  approximate: boolean
}

export function priceFor(model: string | null | undefined): ResolvedPrice | null {
  if (!model) return null
  const id = model.trim().toLowerCase()

  const key = PRICING[id] ? id : id.replace(DATE_SUFFIX, '')
  const exact = PRICING[key]
  if (exact) return { ...exact, key, approximate: false }

  for (const { keyword, key: fallback } of FAMILY_FALLBACK) {
    if (id.includes(keyword)) return { ...PRICING[fallback], key: fallback, approximate: true }
  }
  return null
}

/**
 * Context window for a model, and whether it was inferred from the family.
 * Returns 0 when the model is completely unrecognized.
 */
export function contextWindowFor(model: string | null | undefined): {
  window: number
  approximate: boolean
} {
  const price = priceFor(model)
  if (!price) return { window: 0, approximate: false }
  return { window: price.context, approximate: price.approximate }
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

/** What one API request used, beyond its tokens. */
export interface RequestExtras {
  /** `usage.server_tool_use.web_search_requests` */
  webSearches?: number
  /** `usage.speed === 'fast'` */
  fast?: boolean
  /** `usage.inference_geo === 'us'` */
  usOnly?: boolean
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

/** Prompt size as the pricing page measures it for tiered prices. */
export function promptTokens(t: TokenCounts): number {
  return t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
}

/**
 * USD cost of ONE request.
 *
 * The prompt-size tier (Haiku 5.5) is chosen per request, so this must be
 * called on each turn's own tokens. Summing tokens first and pricing the sum
 * would put a whole session above the threshold.
 */
export function costOf(
  model: string | null | undefined,
  tokens: TokenCounts,
  extras: RequestExtras = {}
): number {
  const price = priceFor(model)
  if (!price) return 0

  const long = price.longPrompt
  const rates = long && promptTokens(tokens) > long.over ? long.rates : price.rates

  let tokenFactor = 1
  let outputRate = rates.output
  if (extras.fast && price.fast) {
    tokenFactor = price.fast.input / price.rates.input
    outputRate = price.fast.output
  }

  const perMillion =
    (tokens.input * rates.input +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite5m * rates.cacheWrite5m +
      tokens.cacheWrite1h * rates.cacheWrite1h) *
      tokenFactor +
    tokens.output * outputRate

  const geo = extras.usOnly && price.dataResidency ? DATA_RESIDENCY_MULTIPLIER : 1
  return (perMillion / 1_000_000) * geo + (extras.webSearches ?? 0) * WEB_SEARCH_USD
}

/**
 * Changes whenever PRICING changes. The usage cache stores costs computed at
 * scan time, so it must be rebuilt when the prices it used are no longer current.
 */
export const PRICING_FINGERPRINT = fingerprint(JSON.stringify(PRICING))

function fingerprint(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
