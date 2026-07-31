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

// --- Sessioni Claude Code ---------------------------------------------------

/**
 * Record scritto da Claude Code in ~/.claude/sessions/<pid>.json.
 * I campi oltre pid/sessionId/cwd sono opzionali di proposito: il formato è
 * interno a Claude Code e può cambiare fra versioni, quindi si legge quello
 * che c'è senza pretenderlo.
 */
export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  kind?: string
  /** 'busy' | 'waiting' | 'idle' | altro. */
  status?: string
  /** Es. 'input needed'. Presente quando status è 'waiting'. */
  waitingFor?: string
  startedAt?: number
  updatedAt?: number
  version?: string
}

/** Sessione passata, ricostruita dal transcript su disco. */
export interface TranscriptSession {
  sessionId: string
  file: string
  /** Etichetta scelta con la catena aiTitle -> lastPrompt -> primo messaggio. */
  label: string
  aiTitle: string | null
  lastPrompt: string | null
  modifiedAt: number
  sizeBytes: number
}

// --- Esplorazione cartelle --------------------------------------------------

export interface DirEntry {
  name: string
  path: string
}

export interface FolderInfo {
  path: string
  exists: boolean
  isGit: boolean
  /** Ramo corrente, letto da .git/HEAD. */
  branch: string | null
  /** Presenza di CLAUDE.md o AGENTS.md. */
  hasInstructions: boolean
  /** Transcript gia' presenti per questa cartella. */
  sessionCount: number
  /** Il dialogo di fiducia di Claude Code e' gia' stato accettato. */
  trusted: boolean
}

/** Da dove arriva una voce del selettore. */
export type CandidateSource = 'favorite' | 'recent' | 'claude' | 'typed' | 'browse'

export interface FolderCandidate {
  path: string
  source: CandidateSource
  lastUsed: number
  /** Indici dei caratteri che corrispondono alla ricerca, per evidenziarli. */
  positions?: number[]
  info?: FolderInfo
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
