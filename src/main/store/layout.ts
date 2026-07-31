import { join } from 'node:path'
import { app } from 'electron'
import type { PersistedLayout } from '@shared/types'
import { readJson, writeJsonAtomic } from './config'

/**
 * Layout salvato fra un avvio e l'altro.
 *
 * Il renderer invia lo stato ad ogni cambiamento; qui si accumula e si scrive
 * al più una volta ogni SAVE_DEBOUNCE_MS. Senza il ritardo, trascinare un
 * canale produrrebbe decine di scritture al secondo.
 */

const SAVE_DEBOUNCE_MS = 800
const CURRENT_VERSION = 1

let pending: PersistedLayout | null = null
let timer: NodeJS.Timeout | null = null

function file(): string {
  return join(app.getPath('userData'), 'layout.json')
}

export function saveLayout(layout: PersistedLayout): void {
  pending = { ...layout, version: CURRENT_VERSION, savedAt: Date.now() }
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    if (pending) writeJsonAtomic(file(), pending)
  }, SAVE_DEBOUNCE_MS)
}

export function loadLayout(): PersistedLayout | null {
  const stored = readJson<PersistedLayout>(file())
  if (!stored || stored.version !== CURRENT_VERSION) return null
  if (!Array.isArray(stored.panes) || stored.panes.length === 0) return null
  return stored
}

/** Scrittura immediata: da usare alla chiusura, quando non c'è più tempo. */
export function flushLayout(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (pending) writeJsonAtomic(file(), pending)
}
