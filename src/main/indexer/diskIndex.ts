import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { IndexKind, IndexStatus } from '@shared/types'
import { listDrives } from '../fs/browse'
import { readJson, writeJsonAtomic } from '../store/config'
import { walk } from './walker'

/**
 * Indici che richiedono una scansione del disco, tenuti separati dalle
 * sorgenti immediate (preferiti, recenti, cartelle già usate con Claude).
 *
 * Ogni indice è persistito e viene ricostruito solo su richiesta esplicita o
 * quando è più vecchio di STALE_MS: una scansione all'avvio renderebbe l'app
 * lenta ad aprirsi proprio quando serve che sia pronta.
 */

const STALE_MS = 24 * 60 * 60 * 1000
const MAX_RESULTS = 20_000

interface StoredIndex {
  version: number
  kind: IndexKind
  scannedAt: number
  roots: string[]
  folders: string[]
}

const VERSION = 1

const status: Record<IndexKind, IndexStatus> = {
  roots: idle('roots'),
  git: idle('git'),
  drive: idle('drive')
}

const running: Partial<Record<IndexKind, { cancelled: boolean }>> = {}

function idle(kind: IndexKind): IndexStatus {
  return { kind, running: false, visited: 0, found: 0, current: '', scannedAt: 0 }
}

function file(kind: IndexKind): string {
  return join(app.getPath('userData'), 'index', `${kind}.json`)
}

function load(kind: IndexKind): StoredIndex | null {
  const stored = readJson<StoredIndex>(file(kind))
  return stored && stored.version === VERSION ? stored : null
}

export function foldersFor(kind: IndexKind): string[] {
  const stored = load(kind)
  if (!stored) return []
  status[kind].scannedAt = stored.scannedAt
  status[kind].found = stored.folders.length
  return stored.folders
}

export function statusOf(kind: IndexKind): IndexStatus {
  if (!status[kind].scannedAt) {
    const stored = load(kind)
    if (stored) {
      status[kind].scannedAt = stored.scannedAt
      status[kind].found = stored.folders.length
    }
  }
  return status[kind]
}

export function allStatuses(): IndexStatus[] {
  return (['roots', 'git', 'drive'] as IndexKind[]).map(statusOf)
}

export function isStale(kind: IndexKind): boolean {
  const stored = load(kind)
  return !stored || Date.now() - stored.scannedAt > STALE_MS
}

export function cancel(kind: IndexKind): void {
  const handle = running[kind]
  if (handle) handle.cancelled = true
}

export interface RescanOptions {
  kind: IndexKind
  /** Radici configurate dall'utente; per 'drive' vengono ignorate. */
  roots: string[]
  onUpdate?: (s: IndexStatus) => void
}

export async function rescan(options: RescanOptions): Promise<IndexStatus> {
  const { kind, onUpdate } = options
  if (status[kind].running) return status[kind]

  const roots =
    kind === 'drive' ? listDrives() : options.roots.filter((r) => r && existsSync(r))

  if (roots.length === 0) {
    status[kind] = { ...idle(kind), scannedAt: Date.now() }
    onUpdate?.(status[kind])
    return status[kind]
  }

  const handle = { cancelled: false }
  running[kind] = handle
  status[kind] = { kind, running: true, visited: 0, found: 0, current: '', scannedAt: 0 }
  onUpdate?.(status[kind])

  const folders = await walk(
    roots,
    {
      // Le radici configurate si fermano a 3 livelli: oltre si entra nei
      // sorgenti dei progetti, che non sono cartelle da aprire.
      maxDepth: kind === 'roots' ? 3 : kind === 'git' ? 6 : 8,
      gitOnly: kind === 'git',
      maxResults: MAX_RESULTS
    },
    (p) => {
      status[kind] = { ...status[kind], ...p }
      onUpdate?.(status[kind])
    },
    handle
  )

  delete running[kind]

  const scannedAt = Date.now()
  // Una scansione annullata non sovrascrive l'indice precedente con un
  // risultato parziale, che sembrerebbe completo al prossimo avvio.
  if (!handle.cancelled) {
    writeJsonAtomic(file(kind), {
      version: VERSION,
      kind,
      scannedAt,
      roots,
      folders
    } satisfies StoredIndex)
  }

  status[kind] = {
    kind,
    running: false,
    visited: status[kind].visited,
    found: folders.length,
    current: '',
    scannedAt: handle.cancelled ? statusOf(kind).scannedAt : scannedAt
  }
  onUpdate?.(status[kind])
  return status[kind]
}
