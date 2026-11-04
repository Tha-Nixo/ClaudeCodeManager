import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import type { DirEntry, FolderInfo } from '@shared/types'
import { normalizePath, transcriptsFor, trustedFolders } from '../claude/paths'

/** Available drives, probes A: .. Z: without external dependencies. */
export function listDrives(): string[] {
  const drives: string[] = []
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`
    try {
      if (existsSync(root)) drives.push(root)
    } catch {
      // Drive not ready (empty drive, disconnected network): skip.
    }
  }
  return drives
}

const HIDDEN_ALWAYS = new Set(['$RECYCLE.BIN', 'System Volume Information', '$Recycle.Bin'])

export interface ListDirResult {
  path: string
  parent: string | null
  entries: DirEntry[]
  error?: string
}

/** Directory contents, subdirectories only: here we choose folders. */
export function listDir(target: string): ListDirResult {
  const path = target || homedir()
  const parsed = parse(path)
  const parent = parsed.root === path ? null : dirname(path)

  try {
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory()) return false
        if (HIDDEN_ALWAYS.has(e.name)) return false
        return true
      })
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))

    return { path, parent, entries }
  } catch (err) {
    return {
      path,
      parent,
      entries: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Current git branch read directly from .git/HEAD.
 * Avoids spawning a git process for each list entry: with dozens
 * of candidates, process overhead would be noticeable.
 */
function gitBranch(folder: string): string | null {
  const head = join(folder, '.git', 'HEAD')
  try {
    if (!existsSync(head)) return null
    const content = readFileSync(head, 'utf8').trim()
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(content)
    if (match) return match[1]
    // Detached HEAD: return abbreviated commit hash.
    return content.slice(0, 7)
  } catch {
    return null
  }
}

/** Badge metadata for a selector entry. */
export function folderInfo(folder: string): FolderInfo {
  let exists = false
  try {
    exists = statSync(folder).isDirectory()
  } catch {
    exists = false
  }

  if (!exists) {
    return {
      path: folder,
      exists: false,
      isGit: false,
      branch: null,
      hasInstructions: false,
      sessionCount: 0,
      trusted: false
    }
  }

  const isGit = existsSync(join(folder, '.git'))
  const hasInstructions =
    existsSync(join(folder, 'CLAUDE.md')) || existsSync(join(folder, 'AGENTS.md'))

  return {
    path: folder,
    exists: true,
    isGit,
    branch: isGit ? gitBranch(folder) : null,
    hasInstructions,
    sessionCount: transcriptsFor(folder).length,
    trusted: trustedFolders().get(normalizePath(folder)) === true
  }
}
