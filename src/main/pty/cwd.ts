import { existsSync } from 'node:fs'
import type { LaunchOptions } from '@shared/types'

/**
 * Folder the shell starts in.
 *
 * A local pane starts where the user asked, or not at all. Before #21 a
 * missing folder fell back to %USERPROFILE%: restoring a pane whose folder had
 * been renamed or deleted ran `claude --resume`, and every tool call of that
 * session, in the home directory. The error now reaches the pane instead.
 *
 * A remote pane runs in `remote.path` on the server. Its local cwd only hosts
 * ssh, so any existing folder will do.
 */
export function spawnCwd(opts: { cwd: string; remote?: LaunchOptions['remote'] }): string {
  if (opts.cwd && existsSync(opts.cwd)) return opts.cwd
  if (opts.remote) return process.env.USERPROFILE || process.cwd()
  throw new Error(
    `The folder ${opts.cwd} no longer exists. It may have been moved, renamed or deleted.`
  )
}
