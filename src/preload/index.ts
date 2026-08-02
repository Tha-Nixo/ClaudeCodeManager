import { contextBridge, ipcRenderer } from 'electron'
import type { CmApi, ListDirResult } from '@shared/api'
import type { ThemeCatalog } from '@shared/theme'
import type {
  AppConfig,
  CreateSessionResult,
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
} from '@shared/types'

/**
 * Superficie esposta al renderer. Volutamente ristretta: nessun accesso al
 * filesystem né a node-pty, solo questi canali. Il preload gira in sandbox,
 * quindi qui dentro si può importare soltanto da 'electron'.
 *
 * L'annotazione `: CmApi` fa sì che una divergenza fra contratto e
 * implementazione diventi un errore di compilazione invece di un `undefined`
 * a runtime dentro il renderer.
 */
const api: CmApi = {
  pty: {
    create: (opts: LaunchOptions): Promise<CreateSessionResult> =>
      ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('pty:kill', id),
    scrollback: (id: string): Promise<string> => ipcRenderer.invoke('pty:scrollback', id),

    onData: (cb: (e: PtyDataEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: PtyDataEvent): void => cb(payload)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (cb: (e: PtyExitEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: PtyExitEvent): void => cb(payload)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    }
  },

  claude: {
    live: (): Promise<LiveSession[]> => ipcRenderer.invoke('claude:live'),
    onLiveChange: (cb: (sessions: LiveSession[]) => void): (() => void) => {
      const listener = (_e: unknown, sessions: LiveSession[]): void => cb(sessions)
      ipcRenderer.on('claude:live-change', listener)
      return () => ipcRenderer.removeListener('claude:live-change', listener)
    },
    sessionsFor: (folder: string): Promise<TranscriptSession[]> =>
      ipcRenderer.invoke('claude:sessionsFor', folder)
  },

  folders: {
    search: (query: string): Promise<FolderCandidate[]> =>
      ipcRenderer.invoke('folders:search', query),
    list: (path: string): Promise<ListDirResult> => ipcRenderer.invoke('folders:list', path),
    drives: (): Promise<string[]> => ipcRenderer.invoke('folders:drives'),
    info: (path: string): Promise<FolderInfo> => ipcRenderer.invoke('folders:info', path),
    favorites: (): Promise<string[]> => ipcRenderer.invoke('folders:favorites'),
    toggleFavorite: (path: string): Promise<string[]> =>
      ipcRenderer.invoke('folders:toggleFavorite', path)
  },

  theme: {
    catalog: (): Promise<ThemeCatalog> => ipcRenderer.invoke('theme:catalog'),
    openDir: (): Promise<void> => ipcRenderer.invoke('theme:openDir')
  },

  ssh: {
    list: (): Promise<SshConnection[]> => ipcRenderer.invoke('ssh:list'),
    save: (input: Partial<SshConnection>): Promise<SshConnection | null> =>
      ipcRenderer.invoke('ssh:save', input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('ssh:delete', id),
    probe: (target: SshTarget): Promise<RemoteProbe> => ipcRenderer.invoke('ssh:probe', target),
    listDir: (target: SshTarget, path: string): Promise<RemoteDirListing> =>
      ipcRenderer.invoke('ssh:listDir', target, path),
    sessionsFor: (
      target: SshTarget,
      path: string
    ): Promise<{ ok: boolean; error?: string; sessions: RemoteSession[] }> =>
      ipcRenderer.invoke('ssh:sessionsFor', target, path)
  },

  index: {
    status: (): Promise<IndexStatus[]> => ipcRenderer.invoke('index:status'),
    rescan: (kind: IndexKind): Promise<IndexStatus> => ipcRenderer.invoke('index:rescan', kind),
    cancel: (kind: IndexKind): void => ipcRenderer.send('index:cancel', kind),
    onProgress: (cb: (status: IndexStatus) => void): (() => void) => {
      const listener = (_e: unknown, status: IndexStatus): void => cb(status)
      ipcRenderer.on('index:progress', listener)
      return () => ipcRenderer.removeListener('index:progress', listener)
    }
  },

  usage: {
    summary: (): Promise<UsageSummary> => ipcRenderer.invoke('usage:summary')
  },

  update: {
    version: (): Promise<string> => ipcRenderer.invoke('update:version'),
    state: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onChange: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_e: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on('update:change', listener)
      return () => ipcRenderer.removeListener('update:change', listener)
    }
  },

  layout: {
    load: (): Promise<PersistedLayout | null> => ipcRenderer.invoke('layout:load'),
    save: (layout: PersistedLayout): void => ipcRenderer.send('layout:save', layout)
  },

  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    set: (patch: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke('config:set', patch)
  },

  win: {
    toggleFullscreen: (): void => ipcRenderer.send('win:toggle-fullscreen'),
    minimize: (): void => ipcRenderer.send('win:minimize'),
    quit: (): void => ipcRenderer.send('win:quit'),
    toggleDevTools: (): void => ipcRenderer.send('win:toggle-devtools')
  }
}

contextBridge.exposeInMainWorld('cm', api)
