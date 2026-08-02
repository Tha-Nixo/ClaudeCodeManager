import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type {
  AppConfig,
  IndexKind,
  LaunchOptions,
  MonitorPane,
  PersistedLayout,
  SshConnection,
  SshTarget
} from '@shared/types'
import type { LiveSessions } from './claude/live'
import { isResumable, sessionsForFolder } from './claude/transcripts'
import { folderInfo, listDir, listDrives } from './fs/browse'
import { allStatuses, cancel as cancelIndex, rescan } from './indexer/diskIndex'
import { invalidateIndex, searchFolders } from './indexer/sources'
import { publishPanes, subscribe, unsubscribe } from './monitor/state'
import { closeMonitorWindow, isMonitorOpen, openMonitorWindow } from './monitor/window'
import type { PtyManager } from './pty/manager'
import {
  isRemoteResumable,
  listDir as listRemoteDir,
  listSessions as listRemoteSessions,
  probe
} from './ssh/remote'
import { getConfig, setConfig } from './store/config'
import {
  deleteConnection,
  listConnections,
  saveConnection,
  touchConnection
} from './store/connections'
import { getFavorites, toggleFavorite, touchRecent } from './store/folders'
import { loadLayout, saveLayout } from './store/layout'
import { ensureThemesDir, loadThemes } from './theme/store'
import { check, currentState, installNow, releaseUrl } from './update/updater'
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
    if (opts.remote) {
      // Per un riquadro remoto la cartella locale non significa niente: quello
      // che vale la pena ricordare e' la connessione con la sua ultima cartella.
      touchConnection(opts.remote.connectionId, opts.remote.path)
    } else {
      // La cartella entra fra i recenti solo se il processo e' davvero partito.
      touchRecent(result.cwd)
      invalidateIndex()
    }
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

  ipcMain.handle('layout:load', async () => {
    try {
      const stored = loadLayout()
      if (!stored) return null
      // Un id salvato non basta: il transcript deve esistere davvero, altrimenti
      // il ripristino avvierebbe claude --resume su una sessione che Claude Code
      // non conosce e il riquadro nascerebbe con un errore invece che pronto.
      //
      // Per i riquadri remoti il transcript sta sul server, quindi il controllo
      // e' una chiamata ssh: si fanno in parallelo e con un tetto di tempo, cosi'
      // un server spento ritarda l'avvio di qualche secondo invece di impedirlo.
      const panes = await Promise.all(
        stored.panes.map(async (pane) => {
          const id = typeof pane.claudeSessionId === 'string' ? pane.claudeSessionId : null
          if (!id) return { ...pane, claudeSessionId: null }

          const remote = pane.launch?.remote
          const alive = remote
            ? await isRemoteResumable(remote, remote.path, id)
            : isResumable(pane.cwd, id)

          return { ...pane, claudeSessionId: alive ? id : null }
        })
      )
      return { ...stored, panes }
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

  // --- Pannello di monitoraggio ---------------------------------------------

  ipcMain.on('monitor:panes', (_e, panes: MonitorPane[]) => publishPanes(panes))
  ipcMain.handle('monitor:subscribe', (e) => subscribe(e.sender))
  ipcMain.on('monitor:unsubscribe', (e) => unsubscribe(e.sender))
  ipcMain.handle('monitor:detached', () => isMonitorOpen())
  ipcMain.handle('monitor:detach', () => {
    openMonitorWindow(!app.isPackaged)
    // Chi ha chiesto lo stacco deve poter aggiornare subito la propria
    // interfaccia senza aspettare un giro di aggiornamento.
    getWindow()?.webContents.send('monitor:detached-change', true)
  })
  ipcMain.handle('monitor:attach', () => {
    closeMonitorWindow()
    getWindow()?.webContents.send('monitor:detached-change', false)
  })

  // --- Aggiornamenti --------------------------------------------------------

  ipcMain.handle('update:state', () => currentState())
  ipcMain.handle('update:check', () => check())
  ipcMain.handle('update:install', () => {
    installNow()
  })
  ipcMain.handle('update:version', () => app.getVersion())
  ipcMain.handle('update:openRelease', async () => {
    await shell.openExternal(releaseUrl())
  })

  // --- Connessioni remote ---------------------------------------------------

  ipcMain.handle('ssh:list', () => listConnections())
  ipcMain.handle('ssh:save', (_e, input: Partial<SshConnection>) => saveConnection(input))
  ipcMain.handle('ssh:delete', (_e, id: string) => {
    deleteConnection(id)
  })
  ipcMain.handle('ssh:probe', (_e, target: SshTarget) => probe(target))
  ipcMain.handle('ssh:listDir', (_e, target: SshTarget, path: string) =>
    listRemoteDir(target, path)
  )
  ipcMain.handle('ssh:sessionsFor', (_e, target: SshTarget, path: string) =>
    listRemoteSessions(target, path)
  )

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
