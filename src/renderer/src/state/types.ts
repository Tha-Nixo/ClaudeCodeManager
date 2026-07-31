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
}

export const STATUS_LABEL: Record<PaneStatus, string> = {
  starting: 'avvio',
  running: 'pronta',
  busy: 'al lavoro',
  waiting: 'attende input',
  exited: 'terminata',
  error: 'errore'
}
