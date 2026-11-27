import type { LaunchOptions, SshTarget, TmuxTarget } from '@shared/types'
import { buildClaudeArgs } from '../claude/cli'

/**
 * Building the ssh command.
 *
 * TWO levels of quoting are crossed here: PowerShell, which starts ssh, and
 * the remote shell, which receives the command as a single string. Getting
 * either one wrong breaks every path with a space in it, and nobody notices
 * until they open a folder that has one.
 *
 * The rule that holds it all together: the remote command uses ONLY single
 * quotes. PowerShell wraps arguments with spaces in double quotes, and an
 * argument without double quotes crosses that level intact.
 */

/**
 * Turns a string into a safe literal for a POSIX shell.
 *
 * A single quote cannot be protected inside single quotes: the string is
 * closed, an escaped quote is added, and the string is reopened. It is the
 * standard way, and the reason the result is full of `'\''`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** SSH connection arguments, excluding destination and remote command. */
function connectionArgs(target: SshTarget): string[] {
  const args: string[] = [
    // Without -t ssh allocates no terminal, and Claude Code cannot draw its
    // interface: only raw output without a prompt would show.
    '-t',
    // A terminal that freezes mid-session would otherwise hang forever with
    // nothing to signal it.
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=4'
  ]
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  if (target.identityFile) {
    args.push('-i', target.identityFile)
    // With an explicitly given key, ssh does not try all the others first and
    // hit the server's limit on attempts.
    args.push('-o', 'IdentitiesOnly=yes')
  }
  return args
}

/** Destination formatted as user@host or host. */
export function sshDestination(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/**
 * There used to be an absolute ban on double quotes in the remote command
 * here: PowerShell 5.1 could not hand them to a native executable, so the
 * only way to stay correct was never to use them. The ban, however, made
 * opening the pane fail with an exception as soon as the user wrote a
 * perfectly normal prompt such as `fix the "login" bug`.
 *
 * Arguments are now protected upstream (see `pty/winargs.ts`), so double
 * quotes cross PowerShell intact and the ban is no longer needed. The remote
 * command still uses single quotes by choice, because they are the simplest
 * way to make a value literal for a POSIX shell.
 */

/**
 * Enters the remote folder and starts claude.
 *
 * `exec` replaces the shell with claude instead of leaving one in between:
 * when claude exits the connection drops at once, with no inert layer keeping
 * the terminal open. If the folder does not exist the command says which one,
 * instead of falling back to the home directory and pretending all went well.
 */
export function remoteCommand(opts: LaunchOptions, sessionId: string): string {
  const path = opts.remote?.path?.trim() || '~'
  const args = buildClaudeArgs(opts, sessionId)

  // A quoted '~' is not expanded by the shell: it would stay a literal folder
  // name. For paths starting with ~ only the rest is quoted.
  //
  // The '--' is not decorative: quotes make the value literal for the shell,
  // but do not stop `cd` from reading it as an option. A folder named '-'
  // would lead to $OLDPWD, that is, somewhere else, silently.
  const cd =
    path === '~'
      ? 'cd -- ~'
      : path.startsWith('~/')
        ? `cd -- ~/${shellQuote(path.slice(2))}`
        : `cd -- ${shellQuote(path)}`

  const claude = ['claude', ...args].map(shellQuote).join(' ')

  return [
    // cd's own error is silenced: the shell prints one of its own, and two
    // messages for the same problem confuse instead of helping.
    `${cd} 2>/dev/null || { echo ${shellQuote(`ClaudeManager: remote directory unreachable: ${path}`)} >&2; exit 1; }`,
    // Without claude on the server the connection would drop at once, leaving
    // only a flashing error. Better to stay on the remote shell: Claude Code can
    // be installed from there without opening another terminal.
    `command -v claude >/dev/null 2>&1 || { echo ${shellQuote('ClaudeManager: Claude Code does not appear to be installed on this remote server.')} >&2; exec ${'${SHELL:-sh}'} -l; }`,
    `exec ${claude}`
  ].join('; ')
}

export interface SshInvocation {
  /** Executable: always ssh, resolved from PATH. */
  file: string
  args: string[]
}

/** Complete command to launch a remote Claude session. */
export function buildSshInvocation(opts: LaunchOptions, sessionId: string): SshInvocation {
  const target = opts.remote
  if (!target) throw new Error('buildSshInvocation requires opts.remote')

  const command = target.tmux ? tmuxAttachCommand(target.tmux) : remoteCommand(opts, sessionId)
  return {
    file: 'ssh',
    args: [...connectionArgs(target), sshDestination(target), command]
  }
}

/**
 * Attaches to an existing tmux session instead of starting claude (#27), and
 * brings up the pane that was picked.
 *
 * `exec` again: detaching (prefix d) ends ssh, and the pane drops back to the
 * local shell like any other remote pane. The session name is matched exactly
 * ('=' prefix): a session called "1" must not be taken for window 1. The ids
 * come from the layout file, so they are checked before being used, and quoted
 * like every other value.
 */
export function tmuxAttachCommand(tmux: TmuxTarget): string {
  const session = `=${tmux.session}`
  const gone = `ClaudeManager: tmux session "${tmux.session}" no longer exists on this server.`
  const attach = ['tmux', 'attach-session', '-t', session]
  if (/^@\d+$/.test(tmux.windowId)) attach.push(';', 'select-window', '-t', tmux.windowId)
  if (/^%\d+$/.test(tmux.paneId)) attach.push(';', 'select-pane', '-t', tmux.paneId)
  return [
    `tmux has-session -t ${shellQuote(session)} 2>/dev/null || { echo ${shellQuote(gone)} >&2; exit 1; }`,
    `exec ${attach.map(shellQuote).join(' ')}`
  ].join('\n')
}

/** Non-interactive ssh command, to query the server. */
export function buildSshQuery(target: SshTarget, remoteScript: string): SshInvocation {
  const args: string[] = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    // No terminal: the output is to be read, not shown.
    '-T'
  ]
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  if (target.identityFile) args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')

  args.push(sshDestination(target), remoteScript)
  return { file: 'ssh', args }
}
