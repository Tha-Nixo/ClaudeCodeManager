import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { LiveSession } from '@shared/types'
import { claudeHome } from './paths'

/**
 * Stato in tempo reale delle sessioni Claude Code.
 *
 * Claude Code scrive un file per processo attivo in ~/.claude/sessions/<pid>.json
 * e lo aggiorna a ogni cambio di stato. È la fonte autorevole: leggendola non
 * serve interpretare l'output del terminale, che sarebbe fragile e dipendente
 * dalla versione.
 *
 * `claude agents --json` espone gli stessi dati ma in forma ridotta (mancano
 * waitingFor, updatedAt e procStart) e costa uno spawn di processo per ogni
 * lettura: qui invece si osserva la cartella e si reagisce agli eventi.
 */

const DEBOUNCE_MS = 120
/** Cadenza con cui si riprova a installare il watcher quando non è possibile. */
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
   * Installa il watcher, e se non è possibile riprova.
   *
   * La cartella non esiste finché Claude Code non avvia la prima sessione: al
   * primo avvio dell'app, quindi, spesso non c'è. Senza il ritentativo lo
   * stato dei riquadri resterebbe congelato per tutta la vita dell'app.
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
      // Un evento 'error' senza ascoltatore su un FSWatcher viene rilanciato e
      // abbatte il main, portandosi dietro tutti i PTY. Qui invece si chiude
      // il watcher e si riprova.
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

  /** Più scritture ravvicinate producono un solo aggiornamento. */
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
      // I file restano indietro dopo un crash: si tiene solo ciò che ha
      // ancora un processo vivo.
      if (!processAlive(rec.pid)) continue
      out.push(rec)
    } catch {
      // File scritto a metà proprio mentre lo leggiamo: al prossimo evento
      // sarà completo.
    }
  }
  return out
}

/**
 * Il segnale 0 non invia nulla: verifica solo l'esistenza del processo.
 *
 * Un PID può essere riusato da un processo qualunque, e senza codice nativo
 * non possiamo confrontare `procStart`. Non è però un problema di
 * attribuzione: i riquadri sono correlati per sessionId, che assegniamo noi
 * con --session-id, quindi al peggio una sessione morta resta indicata come
 * viva finché il suo file non sparisce.
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
