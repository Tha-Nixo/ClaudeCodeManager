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
 * Le opzioni arrivano dal renderer, che non è una fonte fidata: ogni valore
 * che finisce nella riga di comando di claude viene confrontato con
 * l'elenco dei valori ammessi. Uno sconosciuto viene scartato, non passato.
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
    // Pre-assegniamo l'id così sappiamo dove finirà il transcript e con quale
    // chiave matchare il record in ~/.claude/sessions/ prima ancora dello spawn.
    args.push('--session-id', newSessionId)
  }

  const model = pick(opts.model, MODELS)
  if (model) args.push('--model', model)

  const effort = pick(opts.effort, EFFORTS)
  if (effort) args.push('--effort', effort)

  const permissionMode = pick(opts.permissionMode, PERMISSION_MODES)
  if (permissionMode) args.push('--permission-mode', permissionMode)

  // Il nome finisce nel prompt box e nel titolo: si tiene su una sola riga e
  // si scartano i caratteri di controllo.
  //
  // Il controllo di tipo non e' teorico: `name` e `initialPrompt` erano gli
  // unici campi di LaunchOptions senza, e un valore non testuale — da un
  // layout salvato modificato a mano, o da una chiamata sbagliata — sollevava
  // un TypeError che faceva fallire l'apertura del riquadro invece di essere
  // semplicemente ignorato.
  if (typeof opts.name === 'string' && opts.name) {
    const pulito = opts.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
    // Il taglio conta i caratteri veri, non le unita' UTF-16: `slice` spezzava
    // a meta' un'emoji al confine dei 64, lasciando un mezzo surrogato che si
    // vede come carattere sostitutivo nel titolo.
    const name = Array.from(pulito).slice(0, 64).join('')
    if (name) args.push('--name', name)
  }

  const prompt = typeof opts.initialPrompt === 'string' ? opts.initialPrompt.trim() : undefined
  if (prompt) {
    // '--' chiude le opzioni: senza, un prompt che inizia con un trattino
    // verrebbe letto come flag della CLI invece che come testo.
    args.push('--', prompt)
  }

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
  // Stessa validazione di buildClaudeArgs: un id non valido viene scartato lì,
  // quindi la sessione userà comunque quello nuovo. Ritornare l'id rifiutato
  // scollegherebbe il riquadro dal registro delle sessioni vive.
  if (opts.resumeSessionId && UUID.test(opts.resumeSessionId)) return opts.resumeSessionId
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
