import { DEFAULT_THEME_ID } from './themes/builtin'

/**
 * Shared types between main, preload, and renderer.
 * No imports from 'electron' or node modules here: this file
 * is also compiled into renderer bundles.
 */

/** Accepted values for `claude --permission-mode`. 'default' = do not pass flag. */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan'

/** Accepted aliases for `claude --model`. 'default' = do not pass flag. */
export type ModelAlias = 'default' | 'fable' | 'opus' | 'sonnet' | 'haiku'

/** Accepted levels for `claude --effort`. 'default' = do not pass flag. */
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// --- Remote Connections -----------------------------------------------------

/** Connection parameters for a remote server. */
export interface SshTarget {
  host: string
  user: string
  /** 22 if omitted. */
  port?: number
  /** Local path to private key; if omitted ssh defaults apply. */
  identityFile?: string
}

export interface SshConnection extends SshTarget {
  id: string
  /** Label shown in selector. */
  name: string
  /** Remote starting directory. */
  remotePath: string
  /** Epoch ms of last usage for sorting. */
  lastUsed: number
}

/** Remote reference for a pane: connection plus target directory. */
export interface RemoteLaunch extends SshTarget {
  connectionId: string
  /** Remote directory where claude is spawned. */
  path: string
  /** Connection name for pane header. */
  name: string
}

/** Server reconnaissance probe result. */
export interface RemoteProbe {
  ok: boolean
  /** Human-readable error message when `ok` is false. */
  error?: string
  home: string
  /** Remote path to claude binary; empty if not installed. */
  claudePath: string
  claudeVersion: string
  /** Output of `uname -sr`. */
  os: string
}

export interface RemoteEntry {
  name: string
  path: string
  isGit: boolean
  hasInstructions: boolean
}

export interface RemoteDirListing {
  ok: boolean
  error?: string
  /** Absolute path resolved by server with `~` expanded. */
  path: string
  parent: string | null
  entries: RemoteEntry[]
}

/** Conversation already present on remote server, resumable with --resume. */
export interface RemoteSession {
  sessionId: string
  label: string
  aiTitle: string | null
  lastPrompt: string | null
  modifiedAt: number
  sizeBytes: number
}

export interface LaunchOptions {
  /** Directory in which to open session. Windows absolute path. */
  cwd: string
  model?: ModelAlias
  effort?: Effort
  permissionMode?: PermissionMode
  /** Initial text sent to Claude at startup (CLI positional argument). */
  initialPrompt?: string
  /** When set: `--resume <id>` instead of `--session-id <new id>`. */
  resumeSessionId?: string
  /** With resumeSessionId: creates a new id instead of reusing original. */
  forkSession?: boolean
  /** `--continue`: resumes latest conversation in cwd. Mutually exclusive with resume. */
  continueLast?: boolean
  /** `--name`: session name shown in prompt box and ~/.claude/sessions/<pid>.json. */
  name?: string
  /** Initial PTY dimensions, measured by renderer before spawn. */
  cols?: number
  rows?: number
  /**
   * When present, pane opens an ssh connection and executes claude on server.
   * `cwd` remains the local working directory for ssh; remote directory is `remote.path`.
   */
  remote?: RemoteLaunch
}

export interface CreateSessionResult {
  /** Pane ID. Matches `--session-id` except during session resume. */
  id: string
  /** Expected Claude session ID on disk, used to link state and usage. */
  claudeSessionId: string
  cwd: string
  /** Arguments passed to claude, useful for diagnostics. */
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

// --- Claude Code Sessions ---------------------------------------------------

/**
 * Record written by Claude Code in ~/.claude/sessions/<pid>.json.
 * Fields beyond pid/sessionId/cwd are optional: internal format subject to changes.
 */
export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  kind?: string
  /** 'busy' | 'waiting' | 'idle' | other. */
  status?: string
  /** E.g. 'input needed'. Present when status is 'waiting'. */
  waitingFor?: string
  startedAt?: number
  updatedAt?: number
  version?: string
}

/** Past session parsed from disk transcript. */
export interface TranscriptSession {
  sessionId: string
  file: string
  /** Label resolved via chain: aiTitle -> lastPrompt -> first message. */
  label: string
  aiTitle: string | null
  lastPrompt: string | null
  modifiedAt: number
  sizeBytes: number
}

// --- Updates ----------------------------------------------------------------

/**
 * Update check status.
 *
 * 'available' = new version exists but must be installed manually (e.g. portable).
 * 'ready' = downloaded and ready to apply.
 * 'unsupported' = normal state during development.
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** Available version if one exists. */
  version?: string
  /** Download percentage (0-100). */
  percent?: number
  /** Release notes if plain text format. */
  notes?: string
  /** Explanation for 'error', 'available', or 'unsupported'. */
  message?: string
  /** Download release page url when manual update required. */
  releaseUrl?: string
  /** Epoch ms of last successful check. */
  checkedAt?: number
}

// --- Persisted Layout -------------------------------------------------------

/**
 * Snapshot of compositor layout saved between app runs.
 * Tree is stored as opaque JSON: structure defined by renderer layout engine.
 */
export interface PersistedLayout {
  version: number
  savedAt: number
  /** Serialization of renderer `Layout`. */
  tree: unknown
  panes: PersistedPane[]
}

export interface PersistedPane {
  paneId: string
  cwd: string
  launch: LaunchOptions
  /** Claude session ID to resume on restore if known. */
  claudeSessionId: string | null
}

// --- Usage Statistics -------------------------------------------------------

export interface UsageSummary {
  todayCost: number
  todayTokens: number
  weekCost: number
  weekTokens: number
  totalCost: number
  totalTokens: number
  /** Number of transcripts with at least one counted turn. */
  sessions: number
  byModel: { model: string; tokens: number; cost: number }[]
  byProject: { path: string; tokens: number; cost: number }[]
  generatedAt: number
}

/** Single session usage data for monitor panel. */
export interface SessionUsage {
  sessionId: string
  cwd: string | null
  turns: number
  tokens: number
  cost: number
  lastAt: number
  /**
   * Latest turn input tokens including cache: estimates current context fullness.
   */
  contextTokens: number
  /** Context window size for model; 0 when unrecognized. */
  contextWindow: number
  /** Window size is inferred by family heuristic rather than exact match. */
  contextApproximate: boolean
  model: string | null
}

/** Monitor panel entry: pane with its metrics. */
export interface MonitorPane {
  paneId: string
  index: number
  /** Prepared label: terminal title or shortened directory. */
  label: string
  /** Full path: local path or `user@host:/remote/path` if remote. */
  where: string
  status: string
  waitingFor?: string | null
  remote: boolean
  claudeSessionId: string | null
  usage?: SessionUsage
}

/** Complete state displayed by monitor panel, docked or detached. */
export interface MonitorState {
  panes: MonitorPane[]
  /** Today cost and tokens as shown in topbar. */
  todayCost: number
  todayTokens: number
  /** Epoch ms of latest update. */
  updatedAt: number
}

// --- Directory Browsing -----------------------------------------------------

export interface DirEntry {
  name: string
  path: string
}

export interface FolderInfo {
  path: string
  exists: boolean
  isGit: boolean
  /** Current git branch read from .git/HEAD. */
  branch: string | null
  /** Whether CLAUDE.md or AGENTS.md exists. */
  hasInstructions: boolean
  /** Transcripts existing for this directory. */
  sessionCount: number
  /** Claude Code trust dialog already accepted for folder. */
  trusted: boolean
}

/** Origin of candidate folder in selector. */
export type CandidateSource =
  | 'favorite'
  | 'recent'
  | 'claude'
  | 'roots'
  | 'git'
  | 'drive'
  | 'typed'
  | 'browse'

/** Index kinds requiring disk scanning. */
export type IndexKind = 'roots' | 'git' | 'drive'

export interface IndexStatus {
  kind: IndexKind
  running: boolean
  visited: number
  found: number
  /** Directory currently being scanned for progress feedback. */
  current: string
  /** Epoch ms of last completed scan, 0 if never run. */
  scannedAt: number
}

export interface FolderCandidate {
  path: string
  source: CandidateSource
  lastUsed: number
  /** Character indices matching search pattern for highlighting. */
  positions?: number[]
  info?: FolderInfo
}

export interface AppConfig {
  /** Directory used on first launch and as fallback. */
  defaultCwd: string
  /** Preset launch options in selector. */
  launchDefaults: {
    model: ModelAlias
    effort: Effort
    permissionMode: PermissionMode
  }
  /** Initial column and row counts before FitAddon measures element. */
  initialCols: number
  initialRows: number
  /**
   * Resumes conversation of each pane with --resume upon layout restoration,
   * instead of starting empty sessions in the same directories.
   */
  restoreResumesSessions: boolean
  /** Enabled candidate sources for selector index. */
  indexSources: {
    /** Directories previously used with Claude Code, plus recents and favorites. */
    claude: boolean
    /** Configured roots scanned up to 3 levels deep. */
    roots: boolean
    /** Only folders containing a git repository. */
    git: boolean
    /** Complete filesystem drive scan. Heavy: enabled manually. */
    drive: boolean
  }
  /** Root paths used by 'roots' and 'git' indexers. */
  scanRoots: string[]
  /** Active theme ID, built-in or loaded from custom file. */
  themeId: string
  /**
   * Desktop notification when a session transitions to waiting for input.
   * Taskbar flashing remains active regardless as fallback.
   */
  notifyOnWaiting: boolean
  /**
   * Custom keymap: key combo -> action.
   *
   * Overlays on top of default keymap without replacing it entirely.
   * Mapping to empty string unbinds the action.
   */
  keymap: Record<string, string>
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
  // Full drive scan disabled by default: first run takes minutes and requires user opt-in.
  indexSources: { claude: true, roots: true, git: true, drive: false },
  scanRoots: [],
  themeId: DEFAULT_THEME_ID,
  notifyOnWaiting: true,
  keymap: {}
}
