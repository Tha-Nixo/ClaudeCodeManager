import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { LiveSession } from '@shared/types'
import { claudeHome } from './paths'

/**
 * Real-time status of Claude Code sessions.
 *
 * Claude Code writes one file per active process to ~/.claude/sessions/<pid>.json
 * and updates it on every state change. It is the authoritative source: reading it avoids
 * parsing terminal output, which would be fragile and version-dependent.
 *
 * `claude agents --json` exposes the same data in reduced form (missing
 * waitingFor, updatedAt, and procStart) and costs a process spawn for each
 * read: instead, we watch the directory and react to filesystem events.
 */

const DEBOUNCE_MS = 120
/** Interval to retry installing the watcher when not yet possible. */
const RETRY_MS = 5_000

export interface LiveEvents {
  change: [sessions: LiveSession[]]
}

export class LiveSessions extends EventEmitter<LiveEvents> {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  private stopped = false
  private current: LiveSession[] = []

  get sessions(): LiveSession[] {
    return this.current
  }

  start(): void {
    this.refresh()
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.retry) clearInterval(this.retry)
    this.retry = null
    this.watcher?.close()
    this.watcher = null
  }

  /**
   * Installs the watcher, retrying if not currently possible.
   *
   * The directory does not exist until Claude Code launches its first session:
   * on initial app start, it is often absent. Without retrying,
   * pane status would remain frozen for the lifetime of the app.
   */
  private arm(): void {
    if (this.stopped || this.watcher) return

    const dir = sessionsDir()
    if (!existsSync(dir)) {
      this.scheduleRetry()
      return
    }

    try {
      const watcher = watch(dir, () => this.schedule())
      // An unhandled 'error' event on an FSWatcher is re-thrown and
      // crashes the main process, terminating all PTYs. Instead, we close
      // the watcher and retry.
      watcher.on('error', () => {
        watcher.close()
        if (this.watcher === watcher) this.watcher = null
        this.scheduleRetry()
      })
      this.watcher = watcher
      if (this.retry) {
        clearInterval(this.retry)
        this.retry = null
      }
    } catch {
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return
    this.retry = setInterval(() => {
      this.refresh()
      this.arm()
    }, RETRY_MS)
  }

  /** Debounces closely-spaced writes into a single update. */
  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.refresh()
    }, DEBOUNCE_MS)
  }

  private refresh(): void {
    const next = readSessions()
    if (sameAs(this.current, next)) return
    this.current = next
    this.emit('change', next)
  }
}

function sessionsDir(): string {
  return join(claudeHome(), 'sessions')
}

function readSessions(): LiveSession[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const out: LiveSession[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8')
      const rec = JSON.parse(raw) as LiveSession
      if (!rec?.sessionId || typeof rec.pid !== 'number') continue
      // Files can be left behind after a crash: keep only those with an active process.
      if (!processAlive(rec.pid)) continue
      out.push(rec)
    } catch {
      // File half-written while reading: it will be complete on the next event.
    }
  }
  return out
}

/**
 * Signal 0 does not send a signal: it only checks process existence.
 *
 * A PID can be reused by an arbitrary process, and without native code
 * we cannot compare `procStart`. However, this is not an attribution issue:
 * panes are correlated by sessionId, which we assign via --session-id,
 * so at worst a dead session remains marked alive until its file is removed.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sameAs(a: LiveSession[], b: LiveSession[]): boolean {
  if (a.length !== b.length) return false
  const key = (s: LiveSession): string =>
    `${s.sessionId}|${s.status ?? ''}|${s.waitingFor ?? ''}|${s.name ?? ''}`
  const setA = new Set(a.map(key))
  return b.every((s) => setA.has(key(s)))
}
