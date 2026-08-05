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
/**
 * Premio quando TUTTA la ricerca sta dentro il nome finale della cartella.
 *
 * Deve pesare piu' del confine di parola che la lettera di unita' regala per
 * caso, altrimenti `C:\...\Modelli` continuerebbe a battere `ClaudeManager`
 * su 'cm'.
 */
const BONUS_BASENAME_FULL = 45
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
  // toLowerCase() può ALLUNGARE la stringa (es. 'İ' diventa due unità), e in
  // quel caso gli indici trovati su lowerText non sarebbero validi su text.
  // Quando le lunghezze divergono si rinuncia alla ricerca senza distinzione
  // fra maiuscole e minuscole invece di leggere fuori dai limiti.
  const lowered = text.toLowerCase()
  const lowerText = lowered.length === text.length ? lowered : text

  // Inizio del nome finale: i riscontri da qui in poi valgono di piu'.
  const lastSep = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  const baseStart = lastSep + 1

  /** Scorre il pattern cercando ogni carattere a partire da `from`. */
  const scan = (from: number): FuzzyResult | null => {
    const positions: number[] = []
    let score = 0
    let textIndex = from
    let previousMatch = -1

    for (let p = 0; p < lowerPattern.length; p++) {
      const ch = lowerPattern[p]
      if (ch === ' ') continue

      const found = lowerText.indexOf(ch, textIndex)
      if (found === -1) return null

      score += SCORE_MATCH

      const prevChar = (found > 0 ? text[found - 1] : '\\') ?? '\\'
      const here = text[found] ?? ''
      if (BOUNDARY.test(prevChar)) score += BONUS_BOUNDARY
      else if (prevChar === prevChar.toLowerCase() && here !== here.toLowerCase()) {
        score += BONUS_CAMEL
      }

      if (found >= baseStart) score += BONUS_BASENAME

      if (previousMatch >= 0) {
        const gap = found - previousMatch - 1
        if (gap === 0) score += BONUS_CONSECUTIVE
        else score -= Math.min(gap * PENALTY_GAP, 24)
      } else {
        score -= Math.min((found - from) * PENALTY_LEADING, MAX_LEADING_PENALTY)
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

  const intero = scan(0)

  // Secondo tentativo confinato al nome finale.
  //
  // La ricerca dal primo carattere e' avida e irrevocabile: cercando 'cm', la
  // 'c' si aggancia alla lettera di unita' (`C:`), che conta come confine di
  // parola, e da li' in poi qualunque 'm' piu' avanti va bene. Il risultato
  // era che `C:\Users\Chiara\Modelli` e `C:\Users\Carlo\Musica` battevano
  // `C:\dev\ClaudeManager` — cioe' esattamente il caso d'uso per cui questo
  // modulo esiste.
  //
  // Cercare anche dentro il solo nome finale risolve il caso alla radice:
  // 'cm' non ha riscontro dentro `Modelli` o `Musica`, mentre in
  // `ClaudeManager` corrisponde a due iniziali di parola.
  const soloNome = baseStart > 0 ? scan(baseStart) : null
  if (soloNome) soloNome.score += BONUS_BASENAME_FULL

  if (!intero) return soloNome
  if (!soloNome) return intero
  return soloNome.score >= intero.score ? soloNome : intero
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
