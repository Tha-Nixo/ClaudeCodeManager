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

export function fuzzyMatch(pattern: string, text: string): FuzzyResult | null {
  if (pattern.length === 0) return { score: 0, positions: [] }
  if (pattern.length > text.length) return null

  const lowerPattern = pattern.toLowerCase()
  // toLowerCase() can LENGTHEN strings (e.g. 'İ' becomes two code units),
  // in which case indices found in lowerText would be invalid on text.
  // When lengths diverge, fall back to case-sensitive matching rather than reading out of bounds.
  const lowered = text.toLowerCase()
  const lowerText = lowered.length === text.length ? lowered : text

  // Basename start: matches from this index onwards receive a bonus.
  const lastSep = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  const baseStart = lastSep + 1

  /** Scans the pattern matching each character starting from `from`. */
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
