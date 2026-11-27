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
import { devToolsAllowed } from './dev/devtools'
import { listDir } from './fs/browse'
import { allStatuses, cancel as cancelIndex, rescan } from './indexer/diskIndex'
import { invalidateIndex, searchFolders } from './indexer/sources'
import { publishPanes, subscribe, unsubscribe } from './monitor/state'
import {
  closeMonitorWindow,
  isMonitorOpen,
  openMonitorWindow,
  setDetachedListener
} from './monitor/window'
import {
  onLiveChange,
  setFinishNotificationsEnabled,
  setKnownPanes,
  setNotificationsEnabled
} from './notify/notifier'
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
 * Single point of contact between renderer and main. Every channel is registered here
 * and has a typed counterpart in src/preload/index.ts.
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
      // For a remote pane, local folder has no meaning: what is worth
      // remembering is the connection with its last remote path.
      touchConnection(opts.remote.connectionId, opts.remote.path)
    } else {
      // The folder only enters recents if the process actually launched.
      touchRecent(result.cwd)
      invalidateIndex()
    }
    return result
  })

  // write and resize are high frequency: fire-and-forget, no round trip.
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )

  ipcMain.handle('pty:kill', (_e, id: string) => {
    ptys.kill(id)
  })

  // Forward PTY events to the renderer.
  ptys.on('data', (id, data) => {
    getWindow()?.webContents.send('pty:data', { id, data })
  })
  ptys.on('exit', (id, exitCode, signal) => {
    getWindow()?.webContents.send('pty:exit', { id, exitCode, signal })
  })

  // --- Themes -----------------------------------------------------------------

  ipcMain.handle('theme:catalog', () => loadThemes())
  ipcMain.handle('theme:openDir', async () => {
    // Opening the folder is the most direct way to show where theme files go,
    // far clearer than just printing the path.
    await shell.openPath(ensureThemesDir())
  })

  // --- Disk indices ------------------------------------------------------

  ipcMain.handle('index:status', () => allStatuses())

  ipcMain.handle('index:rescan', async (_e, kind: IndexKind) => {
    const result = await rescan({
      kind,
      roots: getConfig().scanRoots,
      // Status is streamed as the scan proceeds: scanning the full disk takes
      // minutes and without progress would appear frozen.
      onUpdate: (s) => getWindow()?.webContents.send('index:progress', s)
    })
    invalidateIndex()
    return result
  })

  ipcMain.on('index:cancel', (_e, kind: IndexKind) => cancelIndex(kind))

  // --- Usage -------------------------------------------------------------

  ipcMain.handle('usage:summary', () => summarize())

  // --- Layout ---------------------------------------------------------------

  ipcMain.handle('layout:load', async () => {
    try {
      const stored = loadLayout()
      if (!stored) return null
      // A stored id is not enough: the transcript must actually exist, otherwise
      // resuming would launch claude --resume on a session Claude Code does not know,
      // starting the pane with an error instead of ready.
      //
      // For remote panes, the transcript is on the server, so checking requires
      // an ssh call: these run in parallel with a timeout, so an offline server
      // delays startup by a few seconds instead of blocking it entirely.
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
      // Better to start in the default folder than fail to launch entirely.
      console.error('Failed to read layout', err)
      return null
    }
  })
  ipcMain.on('layout:save', (_e, layout: PersistedLayout) => saveLayout(layout))

  // --- Claude sessions ------------------------------------------------------

  ipcMain.handle('claude:live', () => live.sessions)
  ipcMain.handle('claude:sessionsFor', (_e, folder: string) => sessionsForFolder(folder))

  live.on('change', (sessions) => {
    getWindow()?.webContents.send('claude:live-change', sessions)
    onLiveChange(sessions, getWindow)
  })

  // --- Monitoring panel ---------------------------------------------

  ipcMain.on('monitor:panes', (_e, panes: MonitorPane[]) => {
    publishPanes(panes)
    // Notifications name the pane and navigate on click: they need the same list.
    setKnownPanes(panes)
  })
  ipcMain.handle('monitor:subscribe', (e) => subscribe(e.sender))
  ipcMain.on('monitor:unsubscribe', (e) => unsubscribe(e.sender))
  ipcMain.handle('monitor:detached', () => isMonitorOpen())
  ipcMain.handle('monitor:detach', () => openMonitorWindow(!app.isPackaged))
  ipcMain.handle('monitor:attach', () => closeMonitorWindow())

  // The announcement originates from the window itself, not just the two commands:
  // this covers direct closing with the X button as well.
  setDetachedListener((detached) =>
    getWindow()?.webContents.send('monitor:detached-change', detached)
  )

  // --- Updates --------------------------------------------------------

  ipcMain.handle('update:state', () => currentState())
  ipcMain.handle('update:check', () => check())
  ipcMain.handle('update:install', () => {
    installNow()
  })
  ipcMain.handle('update:version', () => app.getVersion())
  ipcMain.handle('update:openRelease', async () => {
    await shell.openExternal(releaseUrl())
  })

  // --- Remote connections ---------------------------------------------------

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

  // --- Folders -------------------------------------------------------------

  ipcMain.handle('folders:search', (_e, query: string) => searchFolders(query))
  ipcMain.handle('folders:list', (_e, path: string) => listDir(path))
  ipcMain.handle('folders:favorites', () => getFavorites())
  ipcMain.handle('folders:toggleFavorite', (_e, path: string) => {
    const next = toggleFavorite(path)
    invalidateIndex()
    return next
  })

  // --- Config ---------------------------------------------------------------

  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => {
    const next = setConfig(patch)
    setNotificationsEnabled(next.notifyOnWaiting)
    setFinishNotificationsEnabled(next.notifyOnFinish)
    return next
  })

  // Align initial state immediately: the preference is already on disk.
  setNotificationsEnabled(getConfig().notifyOnWaiting)
  setFinishNotificationsEnabled(getConfig().notifyOnFinish)

  // --- Window -------------------------------------------------------------

  ipcMain.on('win:toggle-fullscreen', () => {
    const win = getWindow()
    if (win) win.setFullScreen(!win.isFullScreen())
  })
  ipcMain.on('win:minimize', () => getWindow()?.minimize())
  ipcMain.on('win:quit', () => getWindow()?.close())
  ipcMain.on('win:toggle-devtools', () => {
    // The window has devTools disabled in packaged builds anyway; returning
    // here keeps that decision in one readable place.
    if (!devToolsAllowed()) return
    const wc = getWindow()?.webContents
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  })
}
