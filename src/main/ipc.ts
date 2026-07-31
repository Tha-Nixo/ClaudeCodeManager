import { BrowserWindow, ipcMain } from 'electron'
import type { AppConfig, LaunchOptions } from '@shared/types'
import { folderInfo, listDir, listDrives } from './fs/browse'
import { invalidateIndex, searchFolders } from './indexer/sources'
import type { PtyManager } from './pty/manager'
import { getConfig, setConfig } from './store/config'
import { getFavorites, toggleFavorite, touchRecent } from './store/folders'

/**
 * Unico punto di contatto fra renderer e main. Ogni canale è registrato qui
 * e ha una controparte tipizzata in src/preload/index.ts.
 */
export function registerIpc(ptys: PtyManager, getWindow: () => BrowserWindow | null): void {
  // --- PTY ------------------------------------------------------------------

  ipcMain.handle('pty:create', (_e, opts: LaunchOptions) => {
    const result = ptys.create(opts)
    // La cartella entra fra i recenti solo se il processo e' davvero partito.
    touchRecent(result.cwd)
    invalidateIndex()
    return result
  })

  // write e resize sono ad alta frequenza: fire-and-forget, niente round trip.
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )

  ipcMain.handle('pty:kill', (_e, id: string) => {
    ptys.kill(id)
  })
  ipcMain.handle('pty:scrollback', (_e, id: string) => ptys.scrollback(id))

  // Inoltro degli eventi del PTY verso il renderer.
  ptys.on('data', (id, data) => {
    getWindow()?.webContents.send('pty:data', { id, data })
  })
  ptys.on('exit', (id, exitCode, signal) => {
    getWindow()?.webContents.send('pty:exit', { id, exitCode, signal })
  })

  // --- Cartelle -------------------------------------------------------------

  ipcMain.handle('folders:search', (_e, query: string) => searchFolders(query))
  ipcMain.handle('folders:list', (_e, path: string) => listDir(path))
  ipcMain.handle('folders:drives', () => listDrives())
  ipcMain.handle('folders:info', (_e, path: string) => folderInfo(path))
  ipcMain.handle('folders:favorites', () => getFavorites())
  ipcMain.handle('folders:toggleFavorite', (_e, path: string) => {
    const next = toggleFavorite(path)
    invalidateIndex()
    return next
  })

  // --- Config ---------------------------------------------------------------

  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => setConfig(patch))

  // --- Finestra -------------------------------------------------------------

  ipcMain.on('win:toggle-fullscreen', () => {
    const win = getWindow()
    if (win) win.setFullScreen(!win.isFullScreen())
  })
  ipcMain.on('win:minimize', () => getWindow()?.minimize())
  ipcMain.on('win:quit', () => getWindow()?.close())
  ipcMain.on('win:toggle-devtools', () => {
    const wc = getWindow()?.webContents
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  })
}
