/**
 * Approximate fzf-style matching tuned for file paths.
 *
 * The heuristic is not just "how many characters match", but WHERE they match:
 * a hit in the basename is worth more than one buried mid-path, and consecutive
 * characters score higher than scattered ones. Without this weighting, searching "man"
 * would rank C:\Users\...\Documents\manuals above ClaudeManager.
 */

const BOUNDARY = /[\\/\-_. ]/

const SCORE_MATCH = 16
const BONUS_BOUNDARY = 30
const BONUS_CAMEL = 20
const BONUS_CONSECUTIVE = 22
const BONUS_BASENAME = 12
/**
 * Bonus when the ENTIRE search pattern matches inside the final directory basename.
 *
 * Must outweigh arbitrary word boundary hits on drive letters (e.g. `C:`),
 * otherwise `C:\...\Models` would continue to beat `ClaudeManager` for query 'cm'.
 */
const BONUS_BASENAME_FULL = 45
const PENALTY_GAP = 3
const PENALTY_LEADING = 2
const MAX_LEADING_PENALTY = 20

export interface FuzzyResult {
  score: number
  /** Indices of matched characters, used for UI highlighting. */
  positions: number[]
}

/**
 * A character as matching sees it: lowercase, without accents.
 *
 * `citta` must find `città`, and `İstanbul` must find itself (#29). Folding
 * decomposes (NFD) and drops the combining marks, so 'à' becomes 'a' and the
 * Turkish 'İ' becomes 'i'. It can change the length of a string, which is why
 * fold() keeps a map back to the original indices.
 */
export function foldChar(ch: string): string {
  return ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

interface Folded {
  text: string
  /**
   * For each unit of `text`, the index of the unit it came from in the original.
   * Null when folding kept every index (all ASCII, the common case).
   */
  map: number[] | null
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/

/** Folds a string code point by code point, remembering where each unit came from. */
export function fold(text: string): Folded {
  // The picker searches on every key press, over thousands of paths, most of
  // them plain ASCII: those need neither normalize() nor a map.
  if (!NON_ASCII.test(text)) return { text: text.toLowerCase(), map: null }

  const parts: string[] = []
  const map: number[] = []
  let index = 0
  for (const cp of text) {
    const folded = cp.charCodeAt(0) < 0x80 ? cp.toLowerCase() : foldChar(cp)
    if (folded.length === cp.length) {
      // Same length (plain letters, emoji): unit for unit, so a surrogate pair
      // keeps two distinct positions.
      for (let j = 0; j < folded.length; j++) map.push(index + j)
    } else {
      // Shorter or longer ('à' from a decomposed pair, a ligature): every
      // folded unit points at the start of the original character.
      for (let j = 0; j < folded.length; j++) map.push(index)
    }
    parts.push(folded)
    index += cp.length
  }
  return { text: parts.join(''), map }
}

export function fuzzyMatch(pattern: string, text: string): FuzzyResult | null {
  if (pattern.length === 0) return { score: 0, positions: [] }

  // Both sides folded the same way: positions are found in the folded text and
  // reported in the original one, so the highlight stays on the right letters.
  const query = fold(pattern).text
  const folded = fold(text)
  if (query.replace(/ /g, '').length > folded.text.length) return null
  const origin = (i: number): number => (folded.map ? folded.map[i] : i)

  // Basename start: matches from this index onwards receive a bonus.
  const lastSep = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  const baseStart = lastSep + 1

  /** Scans the pattern matching each character starting from original index `from`. */
  const scan = (from: number): FuzzyResult | null => {
    const positions: number[] = []
    let score = 0
    let textIndex = folded.map ? folded.map.findIndex((orig) => orig >= from) : from
    if (textIndex === -1) return null
    let previousMatch = -1

    for (let p = 0; p < query.length; p++) {
      const ch = query[p]
      if (ch === ' ') continue

      let foundFolded = folded.text.indexOf(ch, textIndex)
      // A ligature folds into two letters of one character: the second letter
      // must land on a later character, or the highlight would repeat.
      while (foundFolded !== -1 && origin(foundFolded) <= previousMatch) {
        foundFolded = folded.text.indexOf(ch, foundFolded + 1)
      }
      if (foundFolded === -1) return null
      const found = origin(foundFolded)

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
      textIndex = foundFolded + 1
    }

    // On equal matches, prefer shorter paths: almost always closer to what was intended.
    score -= Math.floor(text.length / 12)
    return { score, positions }
  }

  const whole = scan(0)

  // Second pass restricted to the basename.
  //
  // Greedy prefix matching from index 0 can latch the first character
  // onto the drive letter (`C:`), which counts as a word boundary, after
  // which any random later character matches. This caused
  // `C:\Users\Claire\Models` and `C:\Users\Carl\Music` to rank above
  // `C:\dev\ClaudeManager` — the exact scenario this matcher is designed for.
  //
  // Searching also within the basename alone resolves this:
  // 'cm' has no match inside `Models` or `Music`, whereas in
  // `ClaudeManager` it matches two word initials.
  const basenameOnly = baseStart > 0 ? scan(baseStart) : null
  if (basenameOnly) basenameOnly.score += BONUS_BASENAME_FULL

  if (!whole) return basenameOnly
  if (!basenameOnly) return whole
  return basenameOnly.score >= whole.score ? basenameOnly : whole
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
