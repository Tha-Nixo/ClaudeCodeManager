import { BrowserWindow, ipcMain, shell } from 'electron'
import type { AppConfig, IndexKind, LaunchOptions, PersistedLayout } from '@shared/types'
import type { LiveSessions } from './claude/live'
import { isResumable, sessionsForFolder } from './claude/transcripts'
import { folderInfo, listDir, listDrives } from './fs/browse'
import { allStatuses, cancel as cancelIndex, rescan } from './indexer/diskIndex'
import { invalidateIndex, searchFolders } from './indexer/sources'
import type { PtyManager } from './pty/manager'
import { getConfig, setConfig } from './store/config'
import { getFavorites, toggleFavorite, touchRecent } from './store/folders'
import { loadLayout, saveLayout } from './store/layout'
import { ensureThemesDir, loadThemes } from './theme/store'
import { summarize } from './usage/scanner'

/**
 * Unico punto di contatto fra renderer e main. Ogni canale è registrato qui
 * e ha una controparte tipizzata in src/preload/index.ts.
 */
export function registerIpc(
  ptys: PtyManager,
  live: LiveSessions,
  getWindow: () => BrowserWindow | null
): void {
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

  // --- Temi -----------------------------------------------------------------

  ipcMain.handle('theme:catalog', () => loadThemes())
  ipcMain.handle('theme:openDir', async () => {
    // Aprire la cartella e' il modo piu' diretto per far capire dove vanno i
    // file dei temi, molto piu' che scriverne il percorso.
    await shell.openPath(ensureThemesDir())
  })

  // --- Indici su disco ------------------------------------------------------

  ipcMain.handle('index:status', () => allStatuses())

  ipcMain.handle('index:rescan', async (_e, kind: IndexKind) => {
    const result = await rescan({
      kind,
      roots: getConfig().scanRoots,
      // Lo stato viaggia mentre la scansione procede: una scansione dell'intero
      // disco dura minuti e senza avanzamento sembrerebbe bloccata.
      onUpdate: (s) => getWindow()?.webContents.send('index:progress', s)
    })
    invalidateIndex()
    return result
  })

  ipcMain.on('index:cancel', (_e, kind: IndexKind) => cancelIndex(kind))

  // --- Utilizzo -------------------------------------------------------------

  ipcMain.handle('usage:summary', () => summarize())

  // --- Layout ---------------------------------------------------------------

  ipcMain.handle('layout:load', () => {
    try {
      const stored = loadLayout()
      if (!stored) return null
      // Un id salvato non basta: il transcript deve esistere davvero, altrimenti
      // il ripristino avvierebbe claude --resume su una sessione che Claude Code
      // non conosce e il riquadro nascerebbe con un errore invece che pronto.
      return {
        ...stored,
        panes: stored.panes.map((pane) => ({
          ...pane,
          claudeSessionId:
            typeof pane.claudeSessionId === 'string' &&
            isResumable(pane.cwd, pane.claudeSessionId)
              ? pane.claudeSessionId
              : null
        }))
      }
    } catch (err) {
      // Meglio partire sulla cartella predefinita che non partire affatto.
      console.error('lettura del layout fallita', err)
      return null
    }
  })
  ipcMain.on('layout:save', (_e, layout: PersistedLayout) => saveLayout(layout))

  // --- Sessioni Claude ------------------------------------------------------

  ipcMain.handle('claude:live', () => live.sessions)
  ipcMain.handle('claude:sessionsFor', (_e, folder: string) => sessionsForFolder(folder))

  live.on('change', (sessions) => {
    getWindow()?.webContents.send('claude:live-change', sessions)
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
