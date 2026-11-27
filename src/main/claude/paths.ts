import { openSync, readSync, closeSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Working directory to transcripts directory mapping.
 *
 * Claude Code replaces EVERY non-alphanumeric character with '-':
 *   C:\Users\Tha_Nixo\Desktop\ClaudeManager
 *   -> C--Users-Tha-Nixo-Desktop-ClaudeManager
 *
 * The transformation is LOSSY: '_', ' ', '.' and '-' all collapse to '-'.
 * Therefore, we only encode forward, never backward: to recover the real
 * path, read the `cwd` field inside a transcript, or the `project` field
 * in history.jsonl, which already contains the unencoded path.
 */
export function encodeProjectDir(fullPath: string): string {
  // Separators must be normalized BEFORE encoding: 'C:\foo\' and 'C:\foo'
  // are the same folder, but would yield 'C--foo-' and 'C--foo', and only the
  // second matches what Claude Code writes. Drive roots ('C:\') are the exception,
  // because there the separator is significant.
  const normalized = fullPath.replace(/[\\/]+/g, '\\').replace(/(?<!:)\\+$/, '')
  return normalized.replace(/[^a-zA-Z0-9]/g, '-')
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/**
 * Claude Code's own state file (account, MCP servers, per-project trust).
 *
 * It is NOT inside ~/.claude by default: it sits next to it, in the home
 * directory. With CLAUDE_CONFIG_DIR set it moves inside that directory.
 * The docs only say that "settings, session history, and plugins" move, so
 * this was checked against Claude Code 2.1.332 itself: `claude mcp add -s user`
 * with CLAUDE_CONFIG_DIR set writes $CLAUDE_CONFIG_DIR/.claude.json (#20).
 */
export function globalConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json')
}

export function projectsDir(): string {
  return join(claudeHome(), 'projects')
}

export function transcriptsFor(fullPath: string): string[] {
  const dir = join(projectsDir(), encodeProjectDir(fullPath))
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** Normalized paths for comparison: Windows is case-insensitive and
 *  separators appear mixed even within the same configuration file. */
export function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/

/**
 * Extracts the real cwd from a transcript by reading only its head:
 * header records do not have the field, so scanning an initial chunk avoids
 * loading files that can be many megabytes.
 */
export function readCwdFromTranscript(file: string, bytes = 64 * 1024): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    const match = CWD_RE.exec(buf.subarray(0, read).toString('utf8'))
    if (!match) return null
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface KnownFolder {
  path: string
  /** Last time the folder was used, epoch ms. */
  lastUsed: number
  /** Number of prompts recorded in history.jsonl for this folder. */
  uses: number
}

/**
 * Folders where Claude Code has previously been used.
 *
 * The main source is history.jsonl, which lists REAL paths and is a single
 * file to read. Directories in projects/ cover cases not present in history;
 * for those, cwd is retrieved by reading the transcript head, never by decoding
 * the folder name.
 */
export function knownFolders(): KnownFolder[] {
  const byPath = new Map<string, KnownFolder>()

  const add = (path: string, timestamp: number, counts: boolean): void => {
    const key = normalizePath(path)
    const existing = byPath.get(key)
    if (existing) {
      existing.lastUsed = Math.max(existing.lastUsed, timestamp)
      if (counts) existing.uses += 1
    } else {
      byPath.set(key, { path, lastUsed: timestamp, uses: counts ? 1 : 0 })
    }
  }

  // 1. history.jsonl -> real paths, with frequency and recency.
  const history = join(claudeHome(), 'history.jsonl')
  if (existsSync(history)) {
    try {
      for (const line of readFileSync(history, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line) as { project?: string; timestamp?: number }
          if (rec.project) add(rec.project, rec.timestamp ?? 0, true)
        } catch {
          // Corrupted line: ignore and continue.
        }
      }
    } catch {
      // Unreadable history: project directories remain as fallback.
    }
  }

  // 2. projects/ -> folders never recorded in history.
  const dir = projectsDir()
  if (existsSync(dir)) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      entries = []
    }

    for (const entry of entries) {
      // Remote sessions use 'ssh-<uuid>' and not a path scheme:
      // they are not local folders and are excluded from the index.
      if (entry.startsWith('ssh-')) continue

      const projectPath = join(dir, entry)
      let files: string[]
      try {
        files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      if (files.length === 0) continue

      const cwd = readCwdFromTranscript(join(projectPath, files[0]))
      if (!cwd) continue
      if (!byPath.has(normalizePath(cwd))) add(cwd, 0, false)
    }
  }

  return [...byPath.values()].sort((a, b) => b.lastUsed - a.lastUsed)
}

// --- Folder trust -------------------------------------------------

let trustCache: { at: number; file: string; map: Map<string, boolean> } | null = null
const TRUST_TTL_MS = 30_000

/**
 * Folders for which the trust dialog has already been accepted.
 *
 * .claude.json also contains `oauthAccount` and, inside projects[].mcpServers,
 * environment variables with API keys: we extract ONLY hasTrustDialogAccepted
 * and immediately discard the rest, never recording or exposing it.
 */
export function trustedFolders(): Map<string, boolean> {
  const file = globalConfigFile()
  if (trustCache && trustCache.file === file && Date.now() - trustCache.at < TRUST_TTL_MS) {
    return trustCache.map
  }

  const map = new Map<string, boolean>()

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
      }
      for (const [path, entry] of Object.entries(parsed.projects ?? {})) {
        map.set(normalizePath(path), entry?.hasTrustDialogAccepted === true)
      }
    } catch {
      // Missing or unreadable file: no trust badge, nothing else.
    }
  }

  trustCache = { at: Date.now(), file, map }
  return map
}
