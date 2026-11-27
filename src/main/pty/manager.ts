import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import type { CreateSessionResult, LaunchOptions } from '@shared/types'
import { buildClaudeArgs, expectedClaudeSessionId, resolveClaudeExecutable } from '../claude/cli'
import { ensureBootstrapScript, powershellArgs } from './bootstrap'
import { buildPtyEnv } from './env'
import { spawnCwd } from './cwd'
import { buildCommandLine } from './winargs'
import { buildSshInvocation, sshDestination } from '../ssh/command'

/** Output batching interval before sending across IPC. */
const FLUSH_MS = 8
/** Flush threshold: flushed immediately without waiting for the timer. */
const FLUSH_BYTES = 64 * 1024

interface PtySession {
  id: string
  claudeSessionId: string | null
  cwd: string
  pty: IPty
  pending: string[]
  pendingBytes: number
  flushTimer: NodeJS.Timeout | null
  exited: boolean
}

export interface PtyManagerEvents {
  data: [id: string, data: string]
  exit: [id: string, exitCode: number, signal?: number]
}

/**
 * Owns all PTY processes. Lives only in the main process: the renderer
 * never touches node-pty directly.
 */
export class PtyManager extends EventEmitter<PtyManagerEvents> {
  private sessions = new Map<string, PtySession>()

  create(opts: LaunchOptions): CreateSessionResult {
    const id = randomUUID()
    const claudeSessionId = expectedClaudeSessionId(opts, id)

    const cwd = spawnCwd(opts)
    const script = ensureBootstrapScript()

    // A remote pane launches ssh, which in turn runs claude on the server.
    // The bootstrap remains the same: only the executable and arguments change,
    // so upon connection close the user drops into the local shell
    // instead of seeing the pane disappear.
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
        // Composed here according to C runtime rules: left to PowerShell,
        // the command line would lose double quotes and split arguments
        // at the next space.
        commandLine: buildCommandLine(invocation.args),
        label: remote
          ? `Connecting to ${sshDestination(remote)} — ${remote.path}`
          : undefined,
        ownerPid: process.pid
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
    // ConPTY throws on zero dimensions: happens during layout transitions
    // when a pane is momentarily sized at zero.
    if (cols < 1 || rows < 1) return
    try {
      s.pty.resize(cols, rows)
    } catch {
      // The process may have terminated between check and call.
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.flushTimer) clearTimeout(s.flushTimer)
    if (!s.exited) {
      try {
        s.pty.kill()
      } catch {
        // Already terminated: nothing to do.
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

    this.emit('data', s.id, data)
  }
}
