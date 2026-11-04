import type { LaunchOptions } from '@shared/types'

/**
 * Status indicated by the header dot in a pane.
 * 'busy' and 'waiting' are parsed from ~/.claude/sessions/<pid>.json.
 */
export type PaneStatus = 'starting' | 'running' | 'busy' | 'waiting' | 'exited' | 'error'

export interface SessionMeta {
  paneId: string
  cwd: string
  /** Title set by process via OSC, if available. */
  title: string | null
  status: PaneStatus
  launch: LaunchOptions
  error?: string
  /**
   * Session id used on disk: correlates the pane to live session registry.
   */
  claudeSessionId?: string | null
  /** Waiting state details reported by Claude, e.g. 'input needed'. */
  waitingFor?: string | null
}

/**
 * Translates status from ~/.claude/sessions/<pid>.json into UI status.
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
  starting: 'starting',
  running: 'ready',
  busy: 'working',
  waiting: 'waiting for input',
  exited: 'terminated',
  error: 'error'
}
