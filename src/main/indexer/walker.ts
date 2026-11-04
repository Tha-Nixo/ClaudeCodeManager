import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Filesystem traversal to build folder indices.
 *
 * Runs in the main process yielding control to the event loop every YIELD_EVERY entries.
 * The workload is I/O dominated rather than CPU bound: a separate worker thread
 * would require an additional build target in electron-vite and path management
 * in packages without benefits over this approach, since the key requirement is
 * not tying up the event loop while waiting for disk operations. PTY writes
 * and resizes continue to be serviced during scanning.
 */

/** Folders that never contain projects and are costly to traverse. */
const EXCLUDED = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'appdata',
  'node_modules',
  '.git',
  'venv',
  '.venv',
  '__pycache__',
  '.next',
  'dist',
  'build',
  'out',
  'target',
  '.cache',
  'onedrive - temp',
  'msys64',
  'perflogs',
  'recovery',
  '$windows.~bt',
  '$windows.~ws'
])

const YIELD_EVERY = 400

export interface WalkOptions {
  /** Maximum traversal depth relative to root. */
  maxDepth: number
  /** Stops at the first folder containing .git without descending deeper. */
  gitOnly: boolean
  /** Safety ceiling on returned results. */
  maxResults: number
}

export interface WalkProgress {
  visited: number
  found: number
  current: string
}

export interface WalkHandle {
  cancel(): void
}

export async function walk(
  roots: string[],
  options: WalkOptions,
  onProgress: (p: WalkProgress) => void,
  handle: { cancelled: boolean }
): Promise<string[]> {
  const found: string[] = []
  let visited = 0
  let sinceYield = 0

  const queue: { path: string; depth: number }[] = roots.map((path) => ({ path, depth: 0 }))

  while (queue.length > 0) {
    if (handle.cancelled || found.length >= options.maxResults) break

    const { path, depth } = queue.shift()!
    visited += 1

    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      // Access denied, detached drive, path too long: continue.
      continue
    }

    const hasGit = entries.some((e) => e.isDirectory() && e.name === '.git')

    if (options.gitOnly) {
      if (hasGit) {
        found.push(path)
        // A repository is the project root: no need to index deeper inside,
        // which would needlessly traverse all source trees.
        continue
      }
    } else if (depth > 0) {
      found.push(path)
    }

    if (depth >= options.maxDepth) continue

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase()
      if (EXCLUDED.has(name)) continue
      // Hidden folders are rarely top-level user projects.
      if (name.startsWith('.') && name !== '.config') continue
      queue.push({ path: join(path, entry.name), depth: depth + 1 })
    }

    sinceYield += 1
    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      onProgress({ visited, found: found.length, current: basename(path) || path })
      // Yield control to the event loop: without this, scanning an entire drive
      // would block IPC and stall terminals.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  onProgress({ visited, found: found.length, current: '' })
  return found
}
