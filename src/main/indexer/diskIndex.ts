import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { IndexKind, IndexStatus } from '@shared/types'
import { listDrives } from '../fs/browse'
import { readJson, writeJsonAtomic } from '../store/config'
import { walk } from './walker'

/**
 * Indices that require disk scanning, maintained separately from
 * immediate sources (favorites, recents, folders already used with Claude).
 *
 * Each index is persisted and only rebuilt upon explicit request or
 * when older than STALE_MS: an eager scan at launch would make the app
 * slow to start precisely when responsiveness is needed.
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
  /** User-configured roots; ignored for 'drive'. */
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
      // Configured roots stop at depth 3: deeper descends into project source
      // trees, which are not top-level workspaces to open.
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
  // A cancelled scan does not overwrite the previous index with a partial
  // result that would appear complete on next launch.
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
