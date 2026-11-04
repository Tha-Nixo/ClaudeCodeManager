import { join } from 'node:path'
import { app } from 'electron'
import { normalizePath } from '../claude/paths'
import { readJson, writeJsonAtomic } from './config'

interface FoldersState {
  /** Folders opened by ClaudeManager, most recent first. */
  recents: { path: string; lastUsed: number }[]
  /** Pinned user favorites, in order of addition. */
  favorites: string[]
}

const MAX_RECENTS = 40

let cached: FoldersState | null = null

function file(): string {
  return join(app.getPath('userData'), 'folders.json')
}

function load(): FoldersState {
  if (cached) return cached
  const stored = readJson<Partial<FoldersState>>(file())

  // Values must be validated, not just substituted with defaults when missing.
  // With `recents` stored as a string (corrupted file, or hand-edited),
  // the folder selector threw an exception on every open, with no recovery
  // other than deleting the file.
  const recents = Array.isArray(stored?.recents)
    ? stored.recents.filter(
        (r): r is { path: string; lastUsed: number } =>
          Boolean(r) && typeof r === 'object' && typeof (r as { path?: unknown }).path === 'string'
      )
    : []

  const favorites = Array.isArray(stored?.favorites)
    ? stored.favorites.filter((f): f is string => typeof f === 'string')
    : []

  cached = { recents, favorites }
  return cached
}

function persist(): void {
  if (cached) writeJsonAtomic(file(), cached)
}

export function getRecents(): { path: string; lastUsed: number }[] {
  return load().recents
}

export function getFavorites(): string[] {
  return load().favorites
}

/** Records opening a folder; list remains sorted with no duplicates. */
export function touchRecent(path: string): void {
  const state = load()
  const key = normalizePath(path)
  state.recents = [
    { path, lastUsed: Date.now() },
    ...state.recents.filter((r) => normalizePath(r.path) !== key)
  ].slice(0, MAX_RECENTS)
  persist()
}

export function toggleFavorite(path: string): string[] {
  const state = load()
  const key = normalizePath(path)
  const exists = state.favorites.some((f) => normalizePath(f) === key)
  state.favorites = exists
    ? state.favorites.filter((f) => normalizePath(f) !== key)
    : [...state.favorites, path]
  persist()
  return state.favorites
}
