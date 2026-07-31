import { isAbsolute } from 'node:path'
import type { CandidateSource, FolderCandidate } from '@shared/types'
import { knownFolders, normalizePath } from '../claude/paths'
import { folderInfo } from '../fs/browse'
import { getFavorites, getRecents } from '../store/folders'
import { rankBy } from './fuzzy'

/**
 * Indice delle cartelle proposte dal selettore.
 *
 * In M3 le sorgenti attive sono le piu' economiche e le piu' pertinenti:
 * preferiti, recenti dell'app e cartelle in cui Claude Code e' gia' stato
 * usato. Le sorgenti che richiedono una scansione del disco arrivano in M6 e
 * si innestano qui, perche' l'unione e la deduplica sono gia' centralizzate.
 */

const CACHE_TTL_MS = 5_000
let cache: { at: number; items: FolderCandidate[] } | null = null

const SOURCE_RANK: Record<CandidateSource, number> = {
  favorite: 0,
  recent: 1,
  claude: 2,
  typed: 3,
  browse: 4
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
    // A parita' di percorso vince la sorgente piu' significativa: un preferito
    // resta un preferito anche se compare pure fra i recenti.
    if (!existing || SOURCE_RANK[source] < SOURCE_RANK[existing.source]) {
      byPath.set(key, { path, source, lastUsed: Math.max(lastUsed, existing?.lastUsed ?? 0) })
    } else if (lastUsed > existing.lastUsed) {
      existing.lastUsed = lastUsed
    }
  }

  for (const path of getFavorites()) add(path, 'favorite', Date.now())
  for (const r of getRecents()) add(r.path, 'recent', r.lastUsed)
  for (const k of knownFolders()) add(k.path, 'claude', k.lastUsed)

  const items = [...byPath.values()]
  cache = { at: Date.now(), items }
  return items
}

/**
 * Risultati per una query. Con query vuota si mostra l'elenco per pertinenza
 * (preferiti, poi recenti, poi il resto); altrimenti si applica il punteggio
 * fuzzy. Le informazioni per i badge si calcolano solo sulle righe mostrate,
 * cosi' non si tocca il disco per l'intero indice ad ogni tasto premuto.
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

  // Un percorso scritto per intero deve comparire in cima anche se non e'
  // ancora nell'indice: e' la via piu' rapida per aprire una cartella nuova.
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
