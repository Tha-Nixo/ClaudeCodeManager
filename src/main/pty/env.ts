/**
 * Variabili con cui Claude Code marca il proprio processo. Se ClaudeManager
 * viene avviato DA DENTRO un terminale Claude Code, queste finiscono in
 * process.env e verrebbero ereditate da ogni sessione che apriamo.
 *
 * Le conseguenze sono concrete e silenziose:
 * - CLAUDE_CODE_CHILD_SESSION fa considerare la sessione una figlia e
 *   DISATTIVA il salvataggio del transcript. Senza transcript non esistono
 *   né la ripresa delle sessioni né le statistiche di utilizzo.
 * - CLAUDE_CODE_SESSION_ID entrerebbe in conflitto con il --session-id che
 *   assegniamo noi.
 * - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / CLAUDE_PID falsano il rilevamento
 *   del contesto di avvio.
 *
 * Ogni riquadro deve nascere come sessione di primo livello, quindi vanno
 * tolte. L'elenco è volutamente puntuale e non un prefisso: la configurazione
 * dell'utente (CLAUDE_CONFIG_DIR, ANTHROPIC_*, ...) deve passare intatta.
 */
const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID'
] as const

export interface PtyEnvOptions {
  cwd: string
  /** Eseguibile avviato dal bootstrap: `claude` in locale, `ssh` da remoto. */
  exe: string
  argsJson: string
  /** Riga mostrata prima dell'avvio, per dire dove si sta entrando. */
  label?: string
}

/** process.env senza i marcatori di sessione Claude Code. */
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
    CM_ARGS_JSON: opts.argsJson,
    CM_LABEL: opts.label ?? ''
  }
}

/** Usata dalla diagnostica per segnalare che l'app gira dentro Claude Code. */
export function inheritedSessionMarkers(): string[] {
  return SESSION_MARKERS.filter((key) => process.env[key] !== undefined)
}
