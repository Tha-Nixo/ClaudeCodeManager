import { contextBridge, ipcRenderer } from 'electron'
import type { CmApi, ListDirResult } from '@shared/api'
import type {
  AppConfig,
  CreateSessionResult,
  FolderCandidate,
  FolderInfo,
  LaunchOptions,
  PtyDataEvent,
  PtyExitEvent
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
