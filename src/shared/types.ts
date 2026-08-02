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

// --- Layout persistente -----------------------------------------------------

/**
 * Istantanea del compositor salvata fra un avvio e l'altro.
 * L'albero è tenuto come JSON opaco: la sua forma è definita dal motore di
 * layout nel renderer, e il main non ha motivo di conoscerla.
 */
export interface PersistedLayout {
  version: number
  savedAt: number
  /** Serializzazione di `Layout` del renderer. */
  tree: unknown
  panes: PersistedPane[]
}

export interface PersistedPane {
  paneId: string
  cwd: string
  launch: LaunchOptions
  /** Sessione Claude da riprendere al ripristino, se nota. */
  claudeSessionId: string | null
}

// --- Statistiche di utilizzo ------------------------------------------------

export interface UsageSummary {
  todayCost: number
  todayTokens: number
  weekCost: number
  weekTokens: number
  totalCost: number
  totalTokens: number
  /** Numero di transcript con almeno un turno conteggiato. */
  sessions: number
  byModel: { model: string; tokens: number; cost: number }[]
  byProject: { path: string; tokens: number; cost: number }[]
  generatedAt: number
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
export type CandidateSource =
  | 'favorite'
  | 'recent'
  | 'claude'
  | 'roots'
  | 'git'
  | 'drive'
  | 'typed'
  | 'browse'

/** Indici che richiedono una scansione del disco. */
export type IndexKind = 'roots' | 'git' | 'drive'

export interface IndexStatus {
  kind: IndexKind
  running: boolean
  visited: number
  found: number
  /** Cartella in esame, per dare un segno di vita durante la scansione. */
  current: string
  /** Epoch ms dell'ultima scansione completata, 0 se mai eseguita. */
  scannedAt: number
}

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
  /**
   * Al ripristino del layout riprende anche la conversazione di ogni riquadro
   * con --resume, invece di aprire sessioni vuote sulle stesse cartelle.
   */
  restoreResumesSessions: boolean
  /** Sorgenti attive dell'indice del selettore. */
  indexSources: {
    /** Cartelle già usate con Claude Code, più recenti e preferiti. */
    claude: boolean
    /** Radici configurate, scansionate fino a 3 livelli. */
    roots: boolean
    /** Solo cartelle che contengono un repository git. */
    git: boolean
    /** Scansione completa delle unità. Pesante: si attiva a mano. */
    drive: boolean
  }
  /** Radici usate dagli indici 'roots' e 'git'. */
  scanRoots: string[]
}

export const DEFAULT_CONFIG: Omit<AppConfig, 'defaultCwd'> = {
  launchDefaults: {
    model: 'default',
    effort: 'default',
    permissionMode: 'default'
  },
  initialCols: 120,
  initialRows: 30,
  restoreResumesSessions: true,
  // La scansione completa delle unità è l'unica disattivata di default: la
  // prima esecuzione richiede minuti e va decisa dall'utente.
  indexSources: { claude: true, roots: true, git: true, drive: false },
  scanRoots: []
}
