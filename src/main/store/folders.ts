import { join } from 'node:path'
import { app } from 'electron'
import { normalizePath } from '../claude/paths'
import { readJson, writeJsonAtomic } from './config'

interface FoldersState {
  /** Cartelle aperte da ClaudeManager, dalla piu' recente. */
  recents: { path: string; lastUsed: number }[]
  /** Preferiti fissati dall'utente, nell'ordine di aggiunta. */
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

  // I valori vanno controllati, non solo sostituiti quando mancano. Con
  // `recents` uguale a una stringa (file corrotto, o modificato a mano) il
  // selettore di cartelle sollevava un'eccezione ad ogni apertura, e non
  // c'era modo di rimettersi in sesto se non cancellando il file: la funzione
  // principale dell'app restava inaccessibile senza che nulla lo spiegasse.
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

/** Registra l'apertura di una cartella; la lista resta ordinata e senza duplicati. */
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
