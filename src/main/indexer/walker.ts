import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Camminata sul filesystem per costruire l'indice delle cartelle.
 *
 * Gira nel main process ma cede il controllo all'event loop ogni YIELD_EVERY
 * voci. Il lavoro è dominato dall'I/O, non dalla CPU: un worker thread
 * separato costringerebbe a un secondo target di build in electron-vite e a
 * gestirne il percorso nel pacchetto, senza aggiungere nulla rispetto a
 * questo, perché ciò che conta è non tenere occupato il thread mentre si
 * aspetta il disco. La scrittura sui PTY e il ridimensionamento continuano a
 * essere serviti durante la scansione.
 */

/** Cartelle che non contengono mai progetti e che costano moltissimo. */
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
  /** Profondità massima relativa alla radice. */
  maxDepth: number
  /** Si ferma alla prima cartella che contiene .git e non scende oltre. */
  gitOnly: boolean
  /** Tetto di sicurezza sui risultati. */
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
      // Accesso negato, unità staccata, percorso troppo lungo: si prosegue.
      continue
    }

    const hasGit = entries.some((e) => e.isDirectory() && e.name === '.git')

    if (options.gitOnly) {
      if (hasGit) {
        found.push(path)
        // Un repository è la radice del progetto: dentro non c'è altro da
        // indicizzare, e scendere significherebbe visitare tutti i sorgenti.
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
      // Le cartelle nascoste raramente sono progetti dell'utente.
      if (name.startsWith('.') && name !== '.config') continue
      queue.push({ path: join(path, entry.name), depth: depth + 1 })
    }

    sinceYield += 1
    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      onProgress({ visited, found: found.length, current: basename(path) || path })
      // Restituisce il controllo all'event loop: senza questo, una scansione
      // dell'intero disco bloccherebbe l'IPC e i terminali si impunterebbero.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  onProgress({ visited, found: found.length, current: '' })
  return found
}
