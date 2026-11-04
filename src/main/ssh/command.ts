import type { LaunchOptions, SshTarget } from '@shared/types'
import { buildClaudeArgs } from '../claude/cli'

/**
 * SSH command construction.
 *
 * Deals with TWO levels of quoting: PowerShell (which spawns ssh) and the
 * remote shell (which receives the command as a single string).
 *
 * All remote commands strictly use single quotes. PowerShell wraps arguments
 * containing spaces in double quotes, so single-quoted arguments pass through
 * intact.
 */

/** Escapes a string safely for a POSIX shell literal. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** SSH connection arguments, excluding destination and remote command. */
function connectionArgs(target: SshTarget): string[] {
  const args: string[] = [
    // Allocate a pseudo-terminal so Claude Code can render its UI
    '-t',
    // Keep connection alive so hung sessions drop cleanly
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=4'
  ]
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  if (target.identityFile) {
    args.push('-i', target.identityFile)
    args.push('-o', 'IdentitiesOnly=yes')
  }
  return args
}

/** Destination formatted as user@host or host. */
export function sshDestination(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/**
 * Changes into remote directory and runs claude.
 *
 * `exec` replaces the shell with claude directly: exiting claude drops the connection.
 * If the remote directory does not exist, an informative error is displayed.
 */
export function remoteCommand(opts: LaunchOptions, sessionId: string): string {
  const path = opts.remote?.path?.trim() || '~'
  const args = buildClaudeArgs(opts, sessionId)

  const cd =
    path === '~'
      ? 'cd -- ~'
      : path.startsWith('~/')
        ? `cd -- ~/${shellQuote(path.slice(2))}`
        : `cd -- ${shellQuote(path)}`

  const claude = ['claude', ...args].map(shellQuote).join(' ')

  return [
    `${cd} 2>/dev/null || { echo ${shellQuote(`ClaudeManager: remote directory unreachable: ${path}`)} >&2; exit 1; }`,
    `command -v claude >/dev/null 2>&1 || { echo ${shellQuote('ClaudeManager: Claude Code does not appear to be installed on this remote server.')} >&2; exec ${'${SHELL:-sh}'} -l; }`,
    `exec ${claude}`
  ].join('; ')
}

export interface SshInvocation {
  /** Executable: always ssh from PATH. */
  file: string
  args: string[]
}

/** Complete command to launch a remote Claude session. */
export function buildSshInvocation(opts: LaunchOptions, sessionId: string): SshInvocation {
  const target = opts.remote
  if (!target) throw new Error('buildSshInvocation requires opts.remote')

  return {
    file: 'ssh',
    args: [...connectionArgs(target), sshDestination(target), remoteCommand(opts, sessionId)]
  }
}

/** Non-interactive SSH query command for probing remote host. */
export function buildSshQuery(target: SshTarget, remoteScript: string): SshInvocation {
  const args: string[] = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-T'
  ]
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')

  args.push(sshDestination(target), remoteScript)
  return { file: 'ssh', args }
}
