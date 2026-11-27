import type { LiveSession, RemoteLaunch, TmuxTarget } from '@shared/types'
import type { SessionMeta } from './types'

/** The registry's name for a tmux pane: "<session>:<window id>.<pane id>". */
export function tmuxKey(tmux: TmuxTarget): string {
  return `${tmux.session}:${tmux.windowId}.${tmux.paneId}`
}

/**
 * The live session a pane follows.
 *
 * Normally by id: the app chose it with --session-id, or resumed it. A pane
 * attached to tmux (#27) did not start Claude, and whoever runs in that tmux
 * pane can change (Claude exits, a new one starts there): it follows the
 * registry entry whose `tmux` field names its pane, on its own server.
 */
export function liveFor(
  meta: Pick<SessionMeta, 'claudeSessionId' | 'launch'>,
  sessions: LiveSession[]
): LiveSession | undefined {
  const remote = meta.launch.remote
  if (remote?.tmux) {
    const key = tmuxKey(remote.tmux)
    return sessions.find((s) => s.tmux === key && s.remote === remote.connectionId)
  }
  if (!meta.claudeSessionId) return undefined
  return sessions.find((s) => s.sessionId === meta.claudeSessionId)
}

/** Where a remote pane points, for headers and the drawer. */
export function remoteWhere(remote: RemoteLaunch): string {
  return remote.tmux
    ? `${remote.user}@${remote.host} · tmux ${remote.tmux.session}`
    : `${remote.user}@${remote.host}:${remote.path}`
}
