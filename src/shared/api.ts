import type { ThemeCatalog } from './theme'
import type {
  AppConfig,
  CreateSessionResult,
  DirEntry,
  FolderCandidate,
  IndexKind,
  IndexStatus,
  LaunchOptions,
  LiveSession,
  MonitorPane,
  MonitorState,
  PersistedLayout,
  PtyDataEvent,
  PtyExitEvent,
  RemoteDirListing,
  RemoteProbe,
  RemoteSession,
  SshConnection,
  SshTarget,
  TranscriptSession,
  UpdateState,
  UsageSummary
} from './types'

export interface ListDirResult {
  path: string
  parent: string | null
  entries: DirEntry[]
  error?: string
}

/**
 * Contract of the API exposed on `window.cm`.
 *
 * Placed here (not preload) so it is visible to both preload and renderer.
 * No imports from 'electron' to ensure clean renderer bundling.
 */
export interface CmApi {
  pty: {
    create(opts: LaunchOptions): Promise<CreateSessionResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    /** Returns unsubscribe callback. */
    onData(cb: (e: PtyDataEvent) => void): () => void
    /** Returns unsubscribe callback. */
    onExit(cb: (e: PtyExitEvent) => void): () => void
  }
  claude: {
    /** Current status of live Claude Code sessions. */
    live(): Promise<LiveSession[]>
    /** Returns unsubscribe callback. */
    onLiveChange(cb: (sessions: LiveSession[]) => void): () => void
    /** Resumable sessions for a folder, newest first. */
    sessionsFor(folder: string): Promise<TranscriptSession[]>
  }
  folders: {
    /** Fuzzy search on index; empty query = sorted by relevance. */
    search(query: string): Promise<FolderCandidate[]>
    list(path: string): Promise<ListDirResult>
    favorites(): Promise<string[]>
    toggleFavorite(path: string): Promise<string[]>
  }
  theme: {
    /** Built-in themes plus custom themes from files, with any errors. */
    catalog(): Promise<ThemeCatalog>
    /** Opens custom themes folder in OS file manager. */
    openDir(): Promise<void>
  }
  ssh: {
    list(): Promise<SshConnection[]>
    /** Create or update; null if parameters are insufficient. */
    save(input: Partial<SshConnection>): Promise<SshConnection | null>
    delete(id: string): Promise<void>
    /** Test connection and report home, OS, and Claude Code version. */
    probe(target: SshTarget): Promise<RemoteProbe>
    listDir(target: SshTarget, path: string): Promise<RemoteDirListing>
    /** Existing conversations on remote server for path. */
    sessionsFor(
      target: SshTarget,
      path: string
    ): Promise<{ ok: boolean; error?: string; sessions: RemoteSession[] }>
  }
  index: {
    status(): Promise<IndexStatus[]>
    /** Resolves when scan finishes; progress reported via onProgress. */
    rescan(kind: IndexKind): Promise<IndexStatus>
    cancel(kind: IndexKind): void
    /** Returns unsubscribe callback. */
    onProgress(cb: (status: IndexStatus) => void): () => void
  }
  usage: {
    summary(): Promise<UsageSummary>
  }
  monitor: {
    /** Main renderer publishes active panes. Fire-and-forget. */
    publish(panes: MonitorPane[]): void
    /** Starts live updates and returns current state. */
    subscribe(): Promise<MonitorState>
    unsubscribe(): void
    /** Returns unsubscribe callback. */
    onState(cb: (state: MonitorState) => void): () => void
    /** Whether detached monitor window is currently open. */
    isDetached(): Promise<boolean>
    detach(): Promise<void>
    attach(): Promise<void>
    /** Returns unsubscribe callback. */
    onDetachedChange(cb: (detached: boolean) => void): () => void
  }
  update: {
    /** Currently running app version. */
    version(): Promise<string>
    state(): Promise<UpdateState>
    /** Force update check; resolves with updated state. */
    check(): Promise<UpdateState>
    /** Relaunches and installs downloaded update. */
    install(): Promise<void>
    /** Opens download page in external browser. */
    openRelease(): Promise<void>
    /** Returns unsubscribe callback. */
    onChange(cb: (state: UpdateState) => void): () => void
  }
  layout: {
    load(): Promise<PersistedLayout | null>
    /** Fire-and-forget: main process throttles writes. */
    save(layout: PersistedLayout): void
  }
  config: {
    get(): Promise<AppConfig>
    set(patch: Partial<AppConfig>): Promise<AppConfig>
  }
  notify: {
    /**
     * Notification click requests focusing that pane.
     * Returns unsubscribe callback.
     */
    onFocusPane(cb: (paneId: string) => void): () => void
  }
  win: {
    toggleFullscreen(): void
    minimize(): void
    quit(): void
    toggleDevTools(): void
    /** False in packaged builds, unless started with CM_DEVTOOLS=1 (#19). */
    devToolsAllowed: boolean
  }
}
