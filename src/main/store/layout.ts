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

/**
 * Il file su disco è stato scritto dal renderer, può essere di una versione
 * precedente o modificato a mano: ogni riquadro viene validato prima di
 * restituirlo. Un `cwd` mancante farebbe fallire l'intero avvio più a valle,
 * lasciando l'app su uno stage vuoto.
 */
export function loadLayout(): PersistedLayout | null {
  const stored = readJson<PersistedLayout>(file())
  if (!stored || stored.version !== CURRENT_VERSION) return null
  if (!Array.isArray(stored.panes)) return null

  const panes = stored.panes.filter(
    (pane): pane is PersistedLayout['panes'][number] =>
      Boolean(pane) &&
      typeof pane.paneId === 'string' &&
      pane.paneId.length > 0 &&
      typeof pane.cwd === 'string' &&
      pane.cwd.length > 0 &&
      Boolean(pane.launch) &&
      typeof pane.launch === 'object'
  )

  if (panes.length === 0) return null
  return { ...stored, panes }
}

/** Scrittura immediata: da usare alla chiusura, quando non c'è più tempo. */
export function flushLayout(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (pending) writeJsonAtomic(file(), pending)
}
