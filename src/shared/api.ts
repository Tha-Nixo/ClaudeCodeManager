import type { ThemeCatalog } from './theme'
import type {
  AppConfig,
  CreateSessionResult,
  DirEntry,
  FolderCandidate,
  FolderInfo,
  IndexKind,
  IndexStatus,
  LaunchOptions,
  LiveSession,
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
 * Contratto dell'API esposta su `window.cm`.
 *
 * Sta qui, e non nel preload, perché deve essere visibile da entrambi i lati:
 * il preload lo implementa (controllo a compile time), il renderer lo consuma.
 * Nessun import da 'electron', altrimenti finirebbe nel bundle del renderer.
 */
export interface CmApi {
  pty: {
    create(opts: LaunchOptions): Promise<CreateSessionResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    scrollback(id: string): Promise<string>
    /** Ritorna la funzione per disiscriversi. */
    onData(cb: (e: PtyDataEvent) => void): () => void
    /** Ritorna la funzione per disiscriversi. */
    onExit(cb: (e: PtyExitEvent) => void): () => void
  }
  claude: {
    /** Stato corrente delle sessioni Claude Code vive. */
    live(): Promise<LiveSession[]>
    /** Ritorna la funzione per disiscriversi. */
    onLiveChange(cb: (sessions: LiveSession[]) => void): () => void
    /** Sessioni riprendibili per una cartella, dalla più recente. */
    sessionsFor(folder: string): Promise<TranscriptSession[]>
  }
  folders: {
    /** Ricerca fuzzy sull'indice; query vuota = elenco per pertinenza. */
    search(query: string): Promise<FolderCandidate[]>
    list(path: string): Promise<ListDirResult>
    drives(): Promise<string[]>
    info(path: string): Promise<FolderInfo>
    favorites(): Promise<string[]>
    toggleFavorite(path: string): Promise<string[]>
  }
  theme: {
    /** Temi integrati più quelli caricati da file, con gli eventuali errori. */
    catalog(): Promise<ThemeCatalog>
    /** Apre la cartella dei temi personali nell'esplora risorse. */
    openDir(): Promise<void>
  }
  ssh: {
    list(): Promise<SshConnection[]>
    /** Crea o aggiorna; null se i dati non bastano a comporre una connessione. */
    save(input: Partial<SshConnection>): Promise<SshConnection | null>
    delete(id: string): Promise<void>
    /** Prova la connessione e riporta home, sistema e versione di Claude Code. */
    probe(target: SshTarget): Promise<RemoteProbe>
    listDir(target: SshTarget, path: string): Promise<RemoteDirListing>
    /** Conversazioni già presenti sul server per una cartella remota. */
    sessionsFor(
      target: SshTarget,
      path: string
    ): Promise<{ ok: boolean; error?: string; sessions: RemoteSession[] }>
  }
  index: {
    status(): Promise<IndexStatus[]>
    /** Risolve a scansione conclusa; l'avanzamento arriva da onProgress. */
    rescan(kind: IndexKind): Promise<IndexStatus>
    cancel(kind: IndexKind): void
    /** Ritorna la funzione per disiscriversi. */
    onProgress(cb: (status: IndexStatus) => void): () => void
  }
  usage: {
    summary(): Promise<UsageSummary>
  }
  update: {
    /** Versione dell'app in esecuzione. */
    version(): Promise<string>
    state(): Promise<UpdateState>
    /** Forza un controllo; risolve con lo stato risultante. */
    check(): Promise<UpdateState>
    /** Riavvia e installa l'aggiornamento già scaricato. */
    install(): Promise<void>
    /** Ritorna la funzione per disiscriversi. */
    onChange(cb: (state: UpdateState) => void): () => void
  }
  layout: {
    load(): Promise<PersistedLayout | null>
    /** Fire-and-forget: il main accorpa le scritture. */
    save(layout: PersistedLayout): void
  }
  config: {
    get(): Promise<AppConfig>
    set(patch: Partial<AppConfig>): Promise<AppConfig>
  }
  win: {
    toggleFullscreen(): void
    minimize(): void
    quit(): void
    toggleDevTools(): void
  }
}
