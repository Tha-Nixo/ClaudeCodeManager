import type {
  AppConfig,
  CreateSessionResult,
  DirEntry,
  FolderCandidate,
  FolderInfo,
  LaunchOptions,
  PtyDataEvent,
  PtyExitEvent
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
  folders: {
    /** Ricerca fuzzy sull'indice; query vuota = elenco per pertinenza. */
    search(query: string): Promise<FolderCandidate[]>
    list(path: string): Promise<ListDirResult>
    drives(): Promise<string[]>
    info(path: string): Promise<FolderInfo>
    favorites(): Promise<string[]>
    toggleFavorite(path: string): Promise<string[]>
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
