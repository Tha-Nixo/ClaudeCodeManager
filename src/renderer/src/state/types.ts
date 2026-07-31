import type { LaunchOptions } from '@shared/types'

/**
 * Stato mostrato dal pallino nell'intestazione del riquadro.
 * In M2 arriva dal ciclo di vita del processo; da M4 i valori 'busy' e
 * 'waiting' arriveranno da ~/.claude/sessions/<pid>.json, che è la fonte
 * autorevole e non richiede di interpretare l'output del terminale.
 */
export type PaneStatus = 'starting' | 'running' | 'busy' | 'waiting' | 'exited' | 'error'

export interface SessionMeta {
  paneId: string
  cwd: string
  /** Titolo impostato dal processo via OSC, se disponibile. */
  title: string | null
  status: PaneStatus
  launch: LaunchOptions
  error?: string
  /**
   * Id sessione che Claude Code userà su disco: è la chiave con cui il
   * riquadro viene correlato al registro delle sessioni vive. Vale null con
   * --fork-session e --continue, dove l'id lo conia Claude e non è prevedibile.
   */
  claudeSessionId?: string | null
  /** Dettaglio dello stato riportato da Claude, es. 'input needed'. */
  waitingFor?: string | null
}

/**
 * Traduce lo `status` di ~/.claude/sessions/<pid>.json nello stato mostrato.
 * I valori sono quelli osservati; qualunque altro viene trattato come sessione
 * viva e pronta, perché il formato è interno a Claude Code e può cambiare.
 */
export function paneStatusFromLive(status: string | undefined): PaneStatus {
  switch (status) {
    case 'busy':
      return 'busy'
    case 'waiting':
      return 'waiting'
    default:
      return 'running'
  }
}

export const STATUS_LABEL: Record<PaneStatus, string> = {
  starting: 'avvio',
  running: 'pronta',
  busy: 'al lavoro',
  waiting: 'attende input',
  exited: 'terminata',
  error: 'errore'
}
