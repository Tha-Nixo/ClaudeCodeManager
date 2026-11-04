import { execFile } from 'node:child_process'
import type {
  RemoteDirListing,
  RemoteEntry,
  RemoteProbe,
  RemoteSession,
  SshTarget
} from '@shared/types'
import { buildSshQuery, shellQuote } from './command'
import { ptyEnv } from '../pty/env'

/**
 * Non-interactive server queries.
 *
 * All executed via `ssh -T -o BatchMode=yes`: if authentication fails, ssh
 * fails immediately rather than blocking on invisible password prompts.
 * Remote scripts are pure POSIX shell without requiring python or jq.
 */

const QUERY_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export interface SshResult {
  ok: boolean
  stdout: string
  /** Human-readable error message ready for display. */
  error?: string
  /** Exit code from remote script. */
  code: number | null
}

/** Translates raw ssh failures into actionable user guidance. */
function describeFailure(code: number | null, stderr: string): string {
  const raw = stderr.trim()
  const lower = raw.toLowerCase()

  if (lower.includes('permission denied')) {
    return 'Authentication failed. Requires an authorized key on the server (ssh-copy-id) or an ssh-agent with the key loaded: ClaudeManager does not prompt for passwords.'
  }
  if (lower.includes('host key verification failed') || lower.includes('remote host identification')) {
    return 'Host key verification failed. Connect once manually via ssh to accept the host key, then retry.'
  }
  if (lower.includes('could not resolve hostname')) {
    return 'Could not resolve server hostname. Please verify the host address.'
  }
  if (lower.includes('connection refused')) {
    return 'Connection refused: no SSH service listening on specified port.'
  }
  if (
    lower.includes('connection timed out') ||
    lower.includes('operation timed out') ||
    lower.includes('etimedout')
  ) {
    return 'Connection timed out. The server may be offline, unreachable, or under heavy load.'
  }
  if (lower.includes('enoent')) {
    return 'SSH client not found on this system. Enable it in Settings → Apps → Optional features → OpenSSH Client.'
  }
  const first = raw.split('\n').find((l) => l.trim().length > 0)
  if (first) return first.trim()
  return `Server returned an unrecognized response (code ${code ?? 'unknown'}). Connect manually via ssh to inspect the full error.`
}

const EXIT_NO_DIR = 3
const EXIT_NEVER_USED = 4

/** Executes a shell script on remote server and returns stdout. */
export function runRemote(
  target: SshTarget,
  script: string,
  timeoutMs = QUERY_TIMEOUT_MS
): Promise<SshResult> {
  const { file, args } = buildSshQuery(target, script)

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: ptyEnv()
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout, code: 0 })

        const rawCode = (err as { code?: unknown }).code
        const code = typeof rawCode === 'number' ? rawCode : null

        const clue =
          typeof rawCode === 'string'
            ? rawCode
            : (err as { killed?: boolean }).killed
              ? 'ETIMEDOUT'
              : ''

        resolve({
          ok: false,
          stdout,
          code,
          error: describeFailure(code, stderr || clue)
        })
      }
    )
  })
}

const TAB = '\t'

/** Parses non-empty stdout lines into column arrays. */
function rows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'))
}

// --- Server Probing ---------------------------------------------------------

const PROBE_SCRIPT = [
  `printf '%s\\n' "HOME${TAB}$HOME"`,
  `printf '%s\\n' "OS${TAB}$(uname -sr 2>/dev/null)"`,
  'if command -v claude >/dev/null 2>&1; then',
  `  printf '%s\\n' "CLAUDE${TAB}$(command -v claude)"`,
  `  printf '%s\\n' "VERSION${TAB}$(claude --version 2>/dev/null | head -n 1)"`,
  'fi'
].join('\n')

/** Verifies reachability, home directory, and Claude Code presence. */
export async function probe(target: SshTarget): Promise<RemoteProbe> {
  const res = await runRemote(target, PROBE_SCRIPT)
  if (!res.ok) return { ok: false, error: res.error, home: '', claudePath: '', claudeVersion: '', os: '' }

  const map = new Map(rows(res.stdout).map((cols) => [cols[0], cols[1] ?? '']))
  return {
    ok: true,
    home: map.get('HOME') ?? '',
    claudePath: map.get('CLAUDE') ?? '',
    claudeVersion: map.get('VERSION') ?? '',
    os: map.get('OS') ?? ''
  }
}

// --- Remote Directory Browsing ----------------------------------------------

/**
 * Lists subdirectories, detecting git repositories and Claude instructions.
 */
function listScript(path: string): string {
  const target =
    path === '~'
      ? 'cd ~'
      : path.startsWith('~/')
        ? `cd ~/${shellQuote(path.slice(2))}`
        : `cd ${shellQuote(path)}`

  return [
    `${target} 2>/dev/null || exit 3`,
    `printf '%s\\n' "PWD${TAB}$(pwd)"`,
    'for e in * .*; do',
    '  [ "$e" = "." ] && continue',
    '  [ "$e" = ".." ] && continue',
    '  [ -d "$e" ] || continue',
    '  g=0; [ -d "$e/.git" ] && g=1',
    '  m=0; { [ -f "$e/CLAUDE.md" ] || [ -f "$e/AGENTS.md" ]; } && m=1',
    `  printf '%s\\n' "D${TAB}$g${TAB}$m${TAB}$e"`,
    'done'
  ].join('\n')
}

export async function listDir(target: SshTarget, path: string): Promise<RemoteDirListing> {
  const res = await runRemote(target, listScript(path))
  if (!res.ok) {
    const error =
      res.code === EXIT_NO_DIR
        ? 'Directory does not exist or is not accessible on the server.'
        : (res.error ?? 'Unknown error')
    return { ok: false, error, path, parent: null, entries: [] }
  }

  let resolved = path
  const entries: RemoteEntry[] = []

  for (const cols of rows(res.stdout)) {
    if (cols[0] === 'PWD') {
      resolved = cols[1] ?? path
    } else if (cols[0] === 'D' && cols[3]) {
      entries.push({
        name: cols[3],
        path: resolved === '/' ? `/${cols[3]}` : `${resolved}/${cols[3]}`,
        isGit: cols[1] === '1',
        hasInstructions: cols[2] === '1'
      })
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  const cut = resolved.lastIndexOf('/')
  const parent = resolved === '/' ? null : cut <= 0 ? '/' : resolved.slice(0, cut)

  return { ok: true, path: resolved, parent, entries }
}

// --- Resumable Remote Sessions ----------------------------------------------

/**
 * Project directory encoding on POSIX systems: non-alphanumeric converted to hyphens.
 */
function encodeRemoteProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Generates shell script extracting session metadata via grep. */
function sessionsScript(remotePath: string): string {
  const encoded = shellQuote(encodeRemoteProjectDir(remotePath))
  return [
    `d="$HOME/.claude/projects/"${encoded}`,
    '[ -d "$d" ] || exit 4',
    'for f in "$d"/*.jsonl; do',
    '  [ -f "$f" ] || continue',
    '  id=$(basename "$f" .jsonl)',
    '  mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)',
    '  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)',
    '  tl=$(tail -c 200000 "$f")',
    '  t=$(printf %s "$tl" | grep -o \'"aiTitle":"[^"]*"\' | tail -n 1 | cut -d: -f2-)',
    '  p=$(printf %s "$tl" | grep -o \'"lastPrompt":"[^"]*"\' | tail -n 1 | cut -d: -f2-)',
    `  printf '%s\\n' "S${TAB}$id${TAB}$mt${TAB}$sz${TAB}$t${TAB}$p"`,
    'done'
  ].join('\n')
}

/** Strips JSON quote escaping and normalizes whitespace. */
function unquote(raw: string | undefined): string | null {
  if (!raw) return null
  const inner = raw.replace(/^"/, '').replace(/"$/, '')
  if (!inner) return null
  const text = inner
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 160) : null
}

/** Discovers resumable Claude Code sessions for a given remote directory. */
export async function listSessions(
  target: SshTarget,
  remotePath: string
): Promise<{ ok: boolean; error?: string; sessions: RemoteSession[] }> {
  const res = await runRemote(target, sessionsScript(remotePath))

  if (res.code === EXIT_NEVER_USED) return { ok: true, sessions: [] }
  if (!res.ok) return { ok: false, error: res.error, sessions: [] }

  const sessions: RemoteSession[] = []
  for (const cols of rows(res.stdout)) {
    if (cols[0] !== 'S' || !cols[1]) continue
    const aiTitle = unquote(cols[4])
    const lastPrompt = unquote(cols[5])
    sessions.push({
      sessionId: cols[1],
      modifiedAt: Number(cols[2] ?? 0) * 1000,
      sizeBytes: Number(cols[3] ?? 0),
      aiTitle,
      lastPrompt,
      label: aiTitle ?? lastPrompt ?? cols[1].slice(0, 8)
    })
  }

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return { ok: true, sessions }
}

const RESTORE_TIMEOUT_MS = 6000

/**
 * Checks whether a remote session transcript exists for layout restoration.
 */
export async function isRemoteResumable(
  target: SshTarget,
  remotePath: string,
  sessionId: string
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false

  const file = `$HOME/.claude/projects/${encodeRemoteProjectDir(remotePath)}/${sessionId}.jsonl`
  const res = await runRemote(
    target,
    `[ -s "${file}" ] && echo OK`,
    RESTORE_TIMEOUT_MS
  )
  return res.ok && res.stdout.includes('OK')
}
