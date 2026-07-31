/**
 * Tariffe di listino dell'API Anthropic, in dollari per MILIONE di token.
 *
 * Le tariffe di cache derivano da moltiplicatori fissi sul prezzo di input:
 *   lettura da cache      0.1x
 *   scrittura cache 5 min 1.25x
 *   scrittura cache 1 ora 2x
 * Vengono calcolate invece che riscritte a mano, così aggiornare `input`
 * aggiorna coerentemente tutto il resto.
 *
 * ATTENZIONE: sono prezzi API di listino. Con un abbonamento Max o Pro il
 * costo mostrato NON è una spesa reale: è "quanto sarebbe costato via API".
 * La UI deve dirlo esplicitamente.
 *
 * Fonte: skill claude-api (catalogo modelli aggiornato al 2026-06-24).
 */

export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_5M_MULTIPLIER = 1.25
export const CACHE_WRITE_1H_MULTIPLIER = 2

export interface ModelPrice {
  /** Etichetta leggibile per la UI. */
  label: string
  /** Dollari per milione di token di input. */
  input: number
  /** Dollari per milione di token di output. */
  output: number
  /** Nota mostrata accanto al prezzo, es. tariffa introduttiva. */
  note?: string
}

/**
 * Chiavi in ordine di specificità: la ricerca prova prima la corrispondenza
 * esatta, poi il prefisso, infine la famiglia. I modelli della famiglia -5
 * mancano nella tabella di claude-usage, che li farebbe cadere in silenzio
 * sulle tariffe 4.6.
 */
export const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5': { label: 'Fable 5', input: 10, output: 50 },
  'claude-mythos-5': { label: 'Mythos 5', input: 10, output: 50 },
  'claude-opus-5': { label: 'Opus 5', input: 5, output: 25 },
  'claude-opus-4-8': { label: 'Opus 4.8', input: 5, output: 25 },
  'claude-opus-4-7': { label: 'Opus 4.7', input: 5, output: 25 },
  'claude-opus-4-6': { label: 'Opus 4.6', input: 5, output: 25 },
  'claude-opus-4-5': { label: 'Opus 4.5', input: 5, output: 25 },
  // Tariffa introduttiva in vigore fino al 31/08/2026; poi 3 / 15.
  'claude-sonnet-5': {
    label: 'Sonnet 5',
    input: 2,
    output: 10,
    note: 'tariffa introduttiva fino al 31/08/2026'
  },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', input: 3, output: 15 },
  'claude-sonnet-4-5': { label: 'Sonnet 4.5', input: 3, output: 15 },
  'claude-haiku-4-5': { label: 'Haiku 4.5', input: 1, output: 5 }
}

/** Ultima spiaggia per modelli non ancora in tabella. */
const FAMILY_FALLBACK: { keyword: string; key: string }[] = [
  { keyword: 'fable', key: 'claude-fable-5' },
  { keyword: 'mythos', key: 'claude-mythos-5' },
  { keyword: 'opus', key: 'claude-opus-5' },
  { keyword: 'sonnet', key: 'claude-sonnet-5' },
  { keyword: 'haiku', key: 'claude-haiku-4-5' }
]

export interface ResolvedPrice extends ModelPrice {
  /** true quando il prezzo viene da una corrispondenza per famiglia. */
  approximate: boolean
}

export function priceFor(model: string | null | undefined): ResolvedPrice | null {
  if (!model) return null
  const id = model.toLowerCase()

  const exact = PRICING[id]
  if (exact) return { ...exact, approximate: false }

  // Corrispondenza per prefisso: copre gli id con suffisso di data,
  // es. claude-haiku-4-5-20251001.
  for (const [key, value] of Object.entries(PRICING)) {
    if (id.startsWith(key)) return { ...value, approximate: false }
  }

  for (const { keyword, key } of FAMILY_FALLBACK) {
    if (id.includes(keyword)) return { ...PRICING[key], approximate: true }
  }

  return null
}

/** I sotto-agenti e i modelli interni non fatturabili non vanno conteggiati. */
export function isBillable(model: string | null | undefined): boolean {
  return priceFor(model) !== null
}

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  /** Scritture in cache con TTL 5 minuti. */
  cacheWrite5m: number
  /** Scritture in cache con TTL 1 ora, che costano il doppio delle 5 minuti. */
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

/** Costo in dollari di un insieme di token per un dato modello. */
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
