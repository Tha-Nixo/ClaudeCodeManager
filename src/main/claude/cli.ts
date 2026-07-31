import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LaunchOptions } from '@shared/types'

/**
 * Costruisce gli argomenti per `claude` a partire dalle opzioni di lancio.
 *
 * Regole vincolanti (da `claude --help`, v2.1.220):
 * - `--session-id` e `--resume` sono alternativi: chi riprende ha già un id.
 * - `--fork-session` ha senso solo insieme a `--resume`/`--continue`.
 * - il prompt iniziale è un argomento POSIZIONALE e deve stare in fondo.
 */
export function buildClaudeArgs(opts: LaunchOptions, newSessionId: string): string[] {
  const args: string[] = []

  if (opts.continueLast) {
    args.push('--continue')
    if (opts.forkSession) args.push('--fork-session')
  } else if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId)
    if (opts.forkSession) args.push('--fork-session')
  } else {
    // Pre-assegniamo l'id così sappiamo dove finirà il transcript e con quale
    // chiave matchare il record in ~/.claude/sessions/ prima ancora dello spawn.
    args.push('--session-id', newSessionId)
  }

  if (opts.model && opts.model !== 'default') args.push('--model', opts.model)
  if (opts.effort && opts.effort !== 'default') args.push('--effort', opts.effort)
  if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }
  if (opts.name) args.push('--name', opts.name)

  const prompt = opts.initialPrompt?.trim()
  if (prompt) args.push(prompt)

  return args
}

/**
 * L'id sessione che Claude userà davvero su disco.
 * Con `--resume` senza fork è quello ripreso; in tutti gli altri casi è quello
 * che abbiamo generato noi. Con `--fork-session` Claude ne conia uno nuovo che
 * non possiamo prevedere: chi chiama deve trattarlo come sconosciuto.
 */
export function expectedClaudeSessionId(
  opts: LaunchOptions,
  newSessionId: string
): string | null {
  if (opts.forkSession) return null
  if (opts.continueLast) return null
  if (opts.resumeSessionId) return opts.resumeSessionId
  return newSessionId
}

let cachedExe: string | null | undefined

/**
 * Percorso dell'eseguibile claude. Se non lo troviamo restituiamo 'claude'
 * e lasciamo risolvere al PATH dentro PowerShell.
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
