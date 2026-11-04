import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LaunchOptions } from '@shared/types'

/**
 * Builds the arguments for `claude` from launch options.
 *
 * Mandatory rules (from `claude --help`, v2.1.220):
 * - `--session-id` and `--resume` are mutually exclusive: resuming already has an id.
 * - `--fork-session` only makes sense alongside `--resume`/`--continue`.
 * - the initial prompt is a POSITIONAL argument and must be placed at the end.
 */
const MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const PERMISSION_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan'
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Options come from the renderer, which is not a trusted source: every value
 * that ends up in claude's command line is checked against the list of allowed values.
 * Unknown values are discarded, not passed through.
 */
function pick(value: string | undefined, allowed: Set<string>): string | null {
  if (!value || value === 'default') return null
  return allowed.has(value) ? value : null
}

export function buildClaudeArgs(opts: LaunchOptions, newSessionId: string): string[] {
  const args: string[] = []

  const resume = opts.resumeSessionId && UUID.test(opts.resumeSessionId) ? opts.resumeSessionId : null

  if (opts.continueLast) {
    args.push('--continue')
    if (opts.forkSession) args.push('--fork-session')
  } else if (resume) {
    args.push('--resume', resume)
    if (opts.forkSession) args.push('--fork-session')
  } else {
    // Pre-assign the id so we know where the transcript will land and which
    // key to match the record in ~/.claude/sessions/ with even before spawning.
    args.push('--session-id', newSessionId)
  }

  const model = pick(opts.model, MODELS)
  if (model) args.push('--model', model)

  const effort = pick(opts.effort, EFFORTS)
  if (effort) args.push('--effort', effort)

  const permissionMode = pick(opts.permissionMode, PERMISSION_MODES)
  if (permissionMode) args.push('--permission-mode', permissionMode)

  // The name ends up in the prompt box and title: keep it on a single line and
  // discard control characters.
  //
  // Type checking is not theoretical: `name` and `initialPrompt` were the
  // only fields of LaunchOptions without it, and a non-string value — from a
  // hand-edited saved layout, or a malformed call — raised a TypeError
  // that broke pane opening instead of being safely ignored.
  if (typeof opts.name === 'string' && opts.name) {
    const cleaned = opts.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
    // Slicing counts real characters, not UTF-16 code units: `slice` could break
    // an emoji in half at the 64 boundary, leaving a half surrogate that shows
    // as a replacement character in the title.
    const name = Array.from(cleaned).slice(0, 64).join('')
    if (name) args.push('--name', name)
  }

  const prompt = typeof opts.initialPrompt === 'string' ? opts.initialPrompt.trim() : undefined
  if (prompt) {
    // '--' terminates option parsing: without it, a prompt starting with a dash
    // would be parsed as a CLI flag instead of text.
    args.push('--', prompt)
  }

  return args
}

/**
 * The session id that Claude will actually use on disk.
 * With `--resume` without fork it is the resumed one; in all other cases it is
 * the one we generated. With `--fork-session` Claude mints a new one that
 * cannot be predicted: the caller must treat it as unknown.
 */
export function expectedClaudeSessionId(
  opts: LaunchOptions,
  newSessionId: string
): string | null {
  if (opts.forkSession) return null
  if (opts.continueLast) return null
  // Same validation as buildClaudeArgs: an invalid id is rejected there,
  // so the session will use the new one anyway. Returning the rejected id
  // would disconnect the pane from the live session registry.
  if (opts.resumeSessionId && UUID.test(opts.resumeSessionId)) return opts.resumeSessionId
  return newSessionId
}

let cachedExe: string | null | undefined

/**
 * Path of the claude executable. If not found, returns 'claude'
 * and delegates resolution to PATH inside PowerShell.
 */
export function resolveClaudeExecutable(): string {
  if (cachedExe !== undefined) return cachedExe ?? 'claude'

  const candidates = [
    join(homedir(), '.local', 'bin', 'claude.exe'),
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd')
  ]

  cachedExe = candidates.find((p) => existsSync(p)) ?? null
  return cachedExe ?? 'claude'
}
