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

export interface LiveEvents {
  change: [sessions: LiveSession[]]
}

export class LiveSessions extends EventEmitter<LiveEvents> {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private current: LiveSession[] = []

  get sessions(): LiveSession[] {
    return this.current
  }

  start(): void {
    const dir = sessionsDir()
    this.refresh()

    if (!existsSync(dir)) return
    try {
      this.watcher = watch(dir, () => this.schedule())
    } catch {
      // Senza watcher restano i dati letti all'avvio: nessun crash.
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
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
