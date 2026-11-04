import { isAbsolute } from 'node:path'
import type { CandidateSource, FolderCandidate } from '@shared/types'
import { knownFolders, normalizePath } from '../claude/paths'
import { folderInfo } from '../fs/browse'
import { getConfig } from '../store/config'
import { getFavorites, getRecents } from '../store/folders'
import { foldersFor } from './diskIndex'
import { rankBy } from './fuzzy'

/**
 * Folder candidate index proposed by the selector.
 *
 * Combines active sources: favorites, recent app folders, and directories
 * where Claude Code has previously run, plus disk indexer sources (git, roots, drive).
 * Unification and deduplication are centralized here.
 */

const CACHE_TTL_MS = 5_000
let cache: { at: number; items: FolderCandidate[] } | null = null

/**
 * Relevance precedence when paths collide: a favorite remains a favorite
 * even if it also appears among recents or disk scans.
 */
const SOURCE_RANK: Record<CandidateSource, number> = {
  favorite: 0,
  recent: 1,
  claude: 2,
  git: 3,
  roots: 4,
  drive: 5,
  typed: 6,
  browse: 7
}

export function invalidateIndex(): void {
  cache = null
}

function collect(): FolderCandidate[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items

  const byPath = new Map<string, FolderCandidate>()

  const add = (path: string, source: CandidateSource, lastUsed: number): void => {
    const key = normalizePath(path)
    const existing = byPath.get(key)
    // When paths collide, the most significant source wins:
    // a favorite remains a favorite even if it also appears in recents.
    if (!existing || SOURCE_RANK[source] < SOURCE_RANK[existing.source]) {
      byPath.set(key, { path, source, lastUsed: Math.max(lastUsed, existing?.lastUsed ?? 0) })
    } else if (lastUsed > existing.lastUsed) {
      existing.lastUsed = lastUsed
    }
  }

  const sources = getConfig().indexSources

  // Favorites and recents are always active: they are explicit user actions,
  // not scan results.
  for (const path of getFavorites()) add(path, 'favorite', Date.now())
  for (const r of getRecents()) add(r.path, 'recent', r.lastUsed)

  if (sources.claude) for (const k of knownFolders()) add(k.path, 'claude', k.lastUsed)
  if (sources.git) for (const p of foldersFor('git')) add(p, 'git', 0)
  if (sources.roots) for (const p of foldersFor('roots')) add(p, 'roots', 0)
  if (sources.drive) for (const p of foldersFor('drive')) add(p, 'drive', 0)

  const items = [...byPath.values()]
  cache = { at: Date.now(), items }
  return items
}

/**
 * Results for a query. An empty query returns candidates by relevance
 * (favorites, then recents, then others); otherwise fuzzy scoring is applied.
 * Badge metadata is calculated only for visible items, avoiding disk I/O
 * across the entire index on every keystroke.
 */
export function searchFolders(query: string, limit = 40): FolderCandidate[] {
  const all = collect()
  const trimmed = query.trim()

  let results: FolderCandidate[]

  if (trimmed.length === 0) {
    results = [...all]
      .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.lastUsed - a.lastUsed)
      .slice(0, limit)
  } else {
    results = rankBy(trimmed, all, (c) => c.path, limit).map((s) => ({
      ...s.item,
      positions: s.positions
    }))
  }

  // A path typed in full should appear at the top even if not yet in the index:
  // this is the fastest way to open a new folder.
  if (looksLikePath(trimmed)) {
    const key = normalizePath(trimmed)
    if (!results.some((r) => normalizePath(r.path) === key)) {
      results.unshift({ path: trimmed, source: 'typed', lastUsed: Date.now() })
    }
  }

  return results.slice(0, limit).map((c) => ({ ...c, info: folderInfo(c.path) }))
}

function looksLikePath(value: string): boolean {
  if (value.length < 3) return false
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)
}
