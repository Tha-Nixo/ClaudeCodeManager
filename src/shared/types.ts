/**
 * Tipi condivisi fra main, preload e renderer.
 * Nessun import da 'electron' o da moduli node qui dentro: questo file
 * viene compilato anche nel bundle del renderer.
 */

/** Valori accettati da `claude --permission-mode`. 'default' = non passare il flag. */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan'

/** Alias accettati da `claude --model`. 'default' = non passare il flag. */
export type ModelAlias = 'default' | 'fable' | 'opus' | 'sonnet' | 'haiku'

/** Livelli accettati da `claude --effort`. 'default' = non passare il flag. */
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LaunchOptions {
  /** Cartella in cui aprire la sessione. Percorso Windows assoluto. */
  cwd: string
  model?: ModelAlias
  effort?: Effort
  permissionMode?: PermissionMode
  /** Testo inviato a Claude all'avvio (argomento posizionale della CLI). */
  initialPrompt?: string
  /** Se valorizzato: `--resume <id>` invece di `--session-id <nuovo id>`. */
  resumeSessionId?: string
  /** Con resumeSessionId: crea un nuovo id invece di riusare l'originale. */
  forkSession?: boolean
  /** `--continue`: riprende l'ultima conversazione nella cwd. Esclusivo con resume. */
  continueLast?: boolean
  /** `--name`: nome mostrato nel prompt box e in ~/.claude/sessions/<pid>.json */
  name?: string
  /** Dimensioni iniziali del PTY, misurate dal renderer prima dello spawn. */
  cols?: number
  rows?: number
}

export interface CreateSessionResult {
  /** Id del pannello. Coincide con `--session-id` salvo quando si fa resume. */
  id: string
  /** Id sessione Claude atteso su disco, usato per agganciare stato e statistiche. */
  claudeSessionId: string
  cwd: string
  /** Argomenti effettivamente passati a claude, utili per diagnostica. */
  args: string[]
}

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
  signal?: number
}

export interface AppConfig {
  /** Cartella usata al primo avvio e come fallback. */
  defaultCwd: string
  /** Opzioni di lancio preimpostate nel selettore. */
  launchDefaults: {
    model: ModelAlias
    effort: Effort
    permissionMode: PermissionMode
  }
  /** Numero di colonne/righe iniziali prima che FitAddon misuri l'elemento. */
  initialCols: number
  initialRows: number
}

export const DEFAULT_CONFIG: Omit<AppConfig, 'defaultCwd'> = {
  launchDefaults: {
    model: 'default',
    effort: 'default',
    permissionMode: 'default'
  },
  initialCols: 120,
  initialRows: 30
}
