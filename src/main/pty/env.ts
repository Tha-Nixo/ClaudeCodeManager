/**
 * Variables with which Claude Code marks its own process. If ClaudeManager
 * is started FROM WITHIN a Claude Code terminal, these end up in
 * process.env and would be inherited by every session we spawn.
 *
 * The consequences are subtle and destructive:
 * - CLAUDE_CODE_CHILD_SESSION treats the session as a child and
 *   DISABLES transcript saving. Without transcripts, neither session
 *   resumption nor usage analytics function.
 * - CLAUDE_CODE_SESSION_ID would conflict with the --session-id we assign.
 * - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / CLAUDE_PID distort detection
 *   of the launch context.
 *
 * Every pane must spawn as a top-level session, so these must be stripped.
 * The list is intentionally exact rather than a prefix: user configuration
 * (CLAUDE_CONFIG_DIR, ANTHROPIC_*, ...) must pass through intact.
 */
const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID',
  // Same issue, different tool: portable executables produced by
  // electron-builder mark their environment with these, which is how
  // the app detects it cannot update itself. Inherited, they would make
  // any process launched from a pane appear "portable", including
  // another installed copy of ClaudeManager, disabling its updates needlessly.
  'PORTABLE_EXECUTABLE_DIR',
  'PORTABLE_EXECUTABLE_FILE',
  'PORTABLE_EXECUTABLE_APP_FILENAME'
] as const

export interface PtyEnvOptions {
  cwd: string
  /** Executable launched by the bootstrap: `claude` locally, `ssh` remotely. */
  exe: string
  /** Already-composed command line, without the executable. */
  commandLine: string
  /** Header displayed before launch, indicating the target destination. */
  label?: string
}

/** process.env stripped of Claude Code session markers. */
export function ptyEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of SESSION_MARKERS) delete env[key]
  return env
}

export function buildPtyEnv(opts: PtyEnvOptions): Record<string, string | undefined> {
  return {
    ...ptyEnv(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'ClaudeManager',
    CM_CWD: opts.cwd,
    CM_EXE: opts.exe,
    CM_CMDLINE: opts.commandLine,
    CM_LABEL: opts.label ?? ''
  }
}

/** Used by diagnostics to detect whether the app runs inside Claude Code. */
export function inheritedSessionMarkers(): string[] {
  return SESSION_MARKERS.filter((key) => process.env[key] !== undefined)
}
