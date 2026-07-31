/**
 * Corrispondenza approssimata in stile fzf, tarata sui percorsi.
 *
 * Il criterio non e' "quanti caratteri combaciano" ma DOVE combaciano: un
 * riscontro sul nome della cartella vale piu' di uno sepolto a meta' del
 * percorso, e caratteri consecutivi valgono piu' di caratteri sparsi. Senza
 * questi pesi, cercando "man" verrebbe prima C:\Users\...\Documents\manuali
 * di ClaudeManager.
 */

const BOUNDARY = /[\\/\-_. ]/

const SCORE_MATCH = 16
const BONUS_BOUNDARY = 30
const BONUS_CAMEL = 20
const BONUS_CONSECUTIVE = 22
const BONUS_BASENAME = 12
const PENALTY_GAP = 3
const PENALTY_LEADING = 2
const MAX_LEADING_PENALTY = 20

export interface FuzzyResult {
  score: number
  /** Indici dei caratteri corrispondenti, per l'evidenziazione nella UI. */
  positions: number[]
}

export function fuzzyMatch(pattern: string, text: string): FuzzyResult | null {
  if (pattern.length === 0) return { score: 0, positions: [] }
  if (pattern.length > text.length) return null

  const lowerPattern = pattern.toLowerCase()
  const lowerText = text.toLowerCase()

  // Inizio del nome finale: i riscontri da qui in poi valgono di piu'.
  const lastSep = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  const baseStart = lastSep + 1

  const positions: number[] = []
  let score = 0
  let textIndex = 0
  let previousMatch = -1

  for (let p = 0; p < lowerPattern.length; p++) {
    const ch = lowerPattern[p]
    if (ch === ' ') continue

    const found = lowerText.indexOf(ch, textIndex)
    if (found === -1) return null

    score += SCORE_MATCH

    const prevChar = found > 0 ? text[found - 1] : '\\'
    if (BOUNDARY.test(prevChar)) score += BONUS_BOUNDARY
    else if (prevChar === prevChar.toLowerCase() && text[found] !== text[found].toLowerCase()) {
      score += BONUS_CAMEL
    }

    if (found >= baseStart) score += BONUS_BASENAME

    if (previousMatch >= 0) {
      const gap = found - previousMatch - 1
      if (gap === 0) score += BONUS_CONSECUTIVE
      else score -= Math.min(gap * PENALTY_GAP, 24)
    } else {
      score -= Math.min(found * PENALTY_LEADING, MAX_LEADING_PENALTY)
    }

    positions.push(found)
    previousMatch = found
    textIndex = found + 1
  }

  // A parita' di riscontri si preferisce il percorso piu' corto: e' quasi
  // sempre quello piu' vicino a cio' che si cercava.
  score -= Math.floor(text.length / 12)

  return { score, positions }
}

export interface Scored<T> {
  item: T
  score: number
  positions: number[]
}

export function rankBy<T>(
  pattern: string,
  items: T[],
  toText: (item: T) => string,
  limit = 60
): Scored<T>[] {
  const results: Scored<T>[] = []

  for (const item of items) {
    const match = fuzzyMatch(pattern, toText(item))
    if (match) results.push({ item, score: match.score, positions: match.positions })
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}
