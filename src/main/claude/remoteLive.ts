import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { LiveSession, SessionUsage, SshTarget } from '@shared/types'
import { buildSshQuery, shellQuote } from '../ssh/command'
import { WATCH_SCRIPT, WatchParser } from '../ssh/watch'
import { ptyEnv } from '../pty/env'
import { getConnection } from '../store/connections'
import { calibrateSession } from '../usage/calibrate'
import { contextWindowFor, totalTokens } from '../usage/pricing'
import { TranscriptReader } from '../usage/transcript'

/**
 * Live status and usage of remote sessions (#26).
 *
 * Until this existed a remote pane said "remote" and nothing else: no
 * working / waiting / ready, no notification, no cost. One ssh stream per
 * server (see ssh/watch.ts) now brings the server's registry and the tail of
 * its transcripts, and the sessions it reports join the local ones: the
 * renderer, the notifier and the drawer treat them alike.
 *
 * A stream lives while at least one pane uses its connection. When it drops,
 * its sessions disappear (the panes go back to "remote") and it reconnects
 * with a growing delay, without dialogs: a server that is down must not make
 * the app noisy.
 */

const BACKOFF_START_MS = 2_000
const BACKOFF_MAX_MS = 60_000

interface WatcherEvents {
  sessions: [sessions: LiveSession[]]
  transcript: [sessionId: string, reset: boolean, lines: string[]]
}

/** One long-lived ssh stream to one server. */
class RemoteWatcher extends EventEmitter<WatcherEvents> {
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private delay = BACKOFF_START_MS
  private stopped = false

  constructor(
    private readonly connectionId: string,
    private readonly spawnWatch: (target: SshTarget) => ChildProcess
  ) {
    super()
  }

  start(): void {
    if (this.stopped || this.child) return
    const target = getConnection(this.connectionId)
    // The connection was deleted: nothing left to watch.
    if (!target) return

    const parser = new WatchParser()
    const child = this.spawnWatch(target)
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const event of parser.feed(chunk)) {
        if (event.kind === 'sessions') {
          // A snapshot arrived: the connection works, so the next drop
          // starts the backoff from the beginning.
          this.delay = BACKOFF_START_MS
          this.emit('sessions', event.sessions)
        } else {
          this.emit('transcript', event.sessionId, event.reset, event.lines)
        }
      }
    })
    // stderr carries ssh's own complaints: draining it keeps the pipe from
    // filling up; the drop itself is what matters, and 'close' reports it.
    child.stderr?.resume()
    child.on('error', () => this.dropped(child))
    child.on('close', () => this.dropped(child))
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.child?.kill()
    this.child = null
  }

  private dropped(child: ChildProcess): void {
    if (this.child !== child) return
    this.child = null
    this.emit('sessions', [])
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.start()
    }, this.delay)
    this.delay = Math.min(this.delay * 2, BACKOFF_MAX_MS)
  }
}

/** The ssh process for a watch stream: no pty, no timeout, no prompt. */
function spawnSshWatch(target: SshTarget): ChildProcess {
  // The login shell may be anything (fish, zsh): the script is POSIX, so it is
  // handed to sh explicitly.
  const { file, args } = buildSshQuery(target, `exec sh -c ${shellQuote(WATCH_SCRIPT)}`)
  args.splice(args.length - 2, 0, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3')
  return spawn(file, args, { windowsHide: true, env: ptyEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
}

interface RemoteEvents {
  change: []
}

const dayOf = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class RemoteSessions extends EventEmitter<RemoteEvents> {
  private watchers = new Map<
    string,
    { watcher: RemoteWatcher; refs: number; sessions: LiveSession[] }
  >()
  private readers = new Map<string, TranscriptReader>()

  constructor(private readonly spawnWatch: (target: SshTarget) => ChildProcess = spawnSshWatch) {
    super()
  }

  /** A pane on this connection opened: watch its server. */
  retain(connectionId: string): void {
    const known = this.watchers.get(connectionId)
    if (known) {
      known.refs += 1
      return
    }
    const watcher = new RemoteWatcher(connectionId, this.spawnWatch)
    const entry = { watcher, refs: 1, sessions: [] as LiveSession[] }
    this.watchers.set(connectionId, entry)
    watcher.on('sessions', (sessions) => {
      // Tagged with the connection: a tmux pane (#27) finds its Claude session
      // by tmux target, and two servers can both have a "main:@1.%1".
      entry.sessions = sessions.map((s) => ({ ...s, remote: connectionId }))
      this.emit('change')
    })
    watcher.on('transcript', (sessionId, reset, lines) => {
      let reader = this.readers.get(sessionId)
      if (reset || !reader) {
        reader = new TranscriptReader(dayOf)
        this.readers.set(sessionId, reader)
      }
      for (const line of lines) reader.push(line)
    })
    watcher.start()
  }

  /** A pane on this connection closed: stop watching when it was the last. */
  release(connectionId: string): void {
    const entry = this.watchers.get(connectionId)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return
    entry.watcher.stop()
    this.watchers.delete(connectionId)
    for (const session of entry.sessions) this.readers.delete(session.sessionId)
    if (entry.sessions.length > 0) this.emit('change')
  }

  stopAll(): void {
    for (const { watcher } of this.watchers.values()) watcher.stop()
    this.watchers.clear()
    this.readers.clear()
  }

  /** Sessions alive on every watched server. */
  get sessions(): LiveSession[] {
    return [...this.watchers.values()].flatMap((entry) => entry.sessions)
  }

  /**
   * Usage of the remote sessions whose transcript has arrived, in the same
   * shape as the local scanner's: cost calibrated with the server's own
   * cost-state record, context fill from the last turn.
   */
  usage(): Record<string, SessionUsage> {
    const out: Record<string, SessionUsage> = {}
    for (const session of this.sessions) {
      const reader = this.readers.get(session.sessionId)
      if (!reader) continue
      const parsed = reader.result()
      const calibrated = calibrateSession([parsed], dayOf)
      let tokens = 0
      for (const models of Object.values(calibrated.byDay)) {
        for (const usage of Object.values(models)) tokens += totalTokens(usage.tokens)
      }
      const { window, approximate } = contextWindowFor(parsed.lastModel)
      out[session.sessionId] = {
        sessionId: session.sessionId,
        cwd: session.cwd ?? null,
        turns: parsed.turns,
        tokens,
        cost: calibrated.cost,
        reportedCost: calibrated.reportedCost,
        lastAt: parsed.lastAt,
        contextTokens: parsed.lastContext,
        contextWindow: window,
        contextApproximate: approximate,
        model: parsed.lastModel
      }
    }
    return out
  }
}

/** The app's one instance: panes retain and release it from ipc.ts. */
export const remoteSessions = new RemoteSessions()
