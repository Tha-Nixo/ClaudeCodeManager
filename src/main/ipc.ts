import { BrowserWindow, ipcMain } from 'electron'
import type { AppConfig, LaunchOptions } from '@shared/types'
import type { PtyManager } from './pty/manager'
import { getConfig, setConfig } from './store/config'

/**
 * Unico punto di contatto fra renderer e main. Ogni canale è registrato qui
 * e ha una controparte tipizzata in src/preload/index.ts.
 */
export function registerIpc(ptys: PtyManager, getWindow: () => BrowserWindow | null): void {
  // --- PTY ------------------------------------------------------------------

  ipcMain.handle('pty:create', (_e, opts: LaunchOptions) => ptys.create(opts))

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
