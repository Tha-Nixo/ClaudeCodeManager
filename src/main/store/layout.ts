import { join } from 'node:path'
import { app } from 'electron'
import type { PersistedLayout } from '@shared/types'
import { readJson, writeJsonAtomic } from './config'

/**
 * Persisted layout across app launches.
 *
 * The renderer sends state on every change; here it is debounced and written
 * at most once every SAVE_DEBOUNCE_MS. Without debouncing, dragging a gutter
 * would produce dozens of disk writes per second.
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
 * The file on disk was written by the renderer, may belong to an earlier
 * version, or may have been edited by hand: each pane is validated before
 * returning. A missing `cwd` would crash app launch downstream,
 * leaving an empty stage.
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

/** Immediate write: use on app shutdown when time has run out. */
export function flushLayout(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (pending) writeJsonAtomic(file(), pending)
}
