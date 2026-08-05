import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import type { CreateSessionResult, LaunchOptions } from '@shared/types'
import { buildClaudeArgs, expectedClaudeSessionId, resolveClaudeExecutable } from '../claude/cli'
import { ensureBootstrapScript, powershellArgs } from './bootstrap'
import { buildPtyEnv } from './env'
import { buildCommandLine } from './winargs'
import { buildSshInvocation, sshDestination } from '../ssh/command'

/** Intervallo di accorpamento dell'output prima di attraversare l'IPC. */
const FLUSH_MS = 8
/** Oltre questa soglia si scarica subito, senza aspettare il timer. */
const FLUSH_BYTES = 64 * 1024
/** Scrollback tenuto in main per riagganciare il terminale dopo un reload del renderer. */
const SCROLLBACK_LIMIT = 256 * 1024

interface PtySession {
  id: string
  claudeSessionId: string | null
  cwd: string
  pty: IPty
  pending: string[]
  pendingBytes: number
  flushTimer: NodeJS.Timeout | null
  scrollback: string
  exited: boolean
}

export interface PtyManagerEvents {
  data: [id: string, data: string]
  exit: [id: string, exitCode: number, signal?: number]
}

/**
 * Possiede tutti i processi PTY. Vive solo nel main process: il renderer
 * non tocca mai node-pty direttamente.
 */
export class PtyManager extends EventEmitter<PtyManagerEvents> {
  private sessions = new Map<string, PtySession>()

  create(opts: LaunchOptions): CreateSessionResult {
    const id = randomUUID()
    const claudeSessionId = expectedClaudeSessionId(opts, id)

    const cwd = existsSync(opts.cwd) ? opts.cwd : process.env.USERPROFILE || process.cwd()
    const script = ensureBootstrapScript()

    // Un riquadro remoto avvia ssh, che a sua volta esegue claude sul server.
    // Il bootstrap resta lo stesso: cambiano solo eseguibile e argomenti, e
    // così alla chiusura della connessione si resta comunque sulla shell
    // locale invece di veder sparire il riquadro.
    const remote = opts.remote
    const invocation = remote
      ? buildSshInvocation(opts, id)
      : { file: resolveClaudeExecutable(), args: buildClaudeArgs(opts, id) }

    const pty = ptySpawn('powershell.exe', powershellArgs(script), {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd,
      env: buildPtyEnv({
        cwd,
        exe: invocation.file,
        // Composta qui secondo le regole del runtime C: lasciata a PowerShell,
        // la riga di comando perderebbe i doppi apici e spezzerebbe gli
        // argomenti sullo spazio successivo.
        commandLine: buildCommandLine(invocation.args),
        label: remote
          ? `Connessione a ${sshDestination(remote)} — ${remote.path}`
          : undefined
      })
    })

    const session: PtySession = {
      id,
      claudeSessionId,
      cwd,
      pty,
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      scrollback: '',
      exited: false
    }
    this.sessions.set(id, session)

    pty.onData((chunk) => this.queue(session, chunk))
    pty.onExit(({ exitCode, signal }) => {
      session.exited = true
      this.flush(session)
      this.emit('exit', id, exitCode, signal)
    })

    return { id, claudeSessionId: claudeSessionId ?? '', cwd, args: invocation.args }
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (!s || s.exited) return
    s.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || s.exited) return
    // ConPTY va in errore su dimensioni nulle: capita durante le transizioni
    // di layout, quando un riquadro è momentaneamente a zero.
    if (cols < 1 || rows < 1) return
    try {
      s.pty.resize(cols, rows)
    } catch {
      // Il processo può essere morto fra il controllo e la chiamata.
    }
  }

  /** Output accumulato finora, per riagganciare un terminale dopo un reload. */
  scrollback(id: string): string {
    return this.sessions.get(id)?.scrollback ?? ''
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.flushTimer) clearTimeout(s.flushTimer)
    if (!s.exited) {
      try {
        s.pty.kill()
      } catch {
        // Già morto: niente da fare.
      }
    }
    this.sessions.delete(id)
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  private queue(s: PtySession, chunk: string): void {
    s.pending.push(chunk)
    s.pendingBytes += chunk.length

    if (s.pendingBytes >= FLUSH_BYTES) {
      this.flush(s)
      return
    }
    if (s.flushTimer) return
    s.flushTimer = setTimeout(() => this.flush(s), FLUSH_MS)
  }

  private flush(s: PtySession): void {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer)
      s.flushTimer = null
    }
    if (s.pending.length === 0) return

    const data = s.pending.join('')
    s.pending.length = 0
    s.pendingBytes = 0

    s.scrollback += data
    if (s.scrollback.length > SCROLLBACK_LIMIT) {
      s.scrollback = s.scrollback.slice(-SCROLLBACK_LIMIT)
    }

    this.emit('data', s.id, data)
  }
}
