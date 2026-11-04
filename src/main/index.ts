import { join } from 'node:path'
import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { LiveSessions } from './claude/live'
import { installDevBridge } from './dev/bridge'
import { registerIpc } from './ipc'
import { clearAttention, initNotifier } from './notify/notifier'
import { PtyManager } from './pty/manager'
import { flushLayout } from './store/layout'
import { initUpdater, stopUpdater } from './update/updater'

const isDev = !app.isPackaged
/** In development, windowed mode can be enabled: CM_WINDOWED=1 npm run dev */
const startWindowed = isDev && process.env.CM_WINDOWED === '1'

let mainWindow: BrowserWindow | null = null
const ptys = new PtyManager()
const live = new LiveSessions()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    show: false,
    frame: false,
    fullscreen: !startWindowed,
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1F1E1D',
    title: 'ClaudeManager',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Refocusing the app responds to the notification: flashing has fulfilled
  // its purpose and continuing would just be annoying.
  mainWindow.on('focus', () => mainWindow && clearAttention(mainWindow))

  // External links must never navigate within the app window, and
  // should only be handed off to the system if http/https: shell.openExternal
  // also opens file:, ms-settings: and any registered scheme, while
  // the URL originates from the renderer, an untrusted boundary.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url)
      }
    } catch {
      // Malformed URL: ignore.
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  // A restarted renderer (dev reload, crash) loses all PTY references:
  // otherwise orphan processes would remain that no UI could reach or close.
  // We kill at the START of a new load, not the end: so old processes are
  // gone before the new renderer starts re-instantiating them.
  let loadedOnce = false
  mainWindow.webContents.on('did-start-loading', () => {
    if (loadedOnce) ptys.killAll()
  })
  mainWindow.webContents.on('did-stop-loading', () => {
    loadedOnce = true
  })
  mainWindow.webContents.on('render-process-gone', () => ptys.killAll())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * CSP applied only in production: in development Vite requires eval and
 * a websocket connection for HMR, which a strict policy would block.
 */
function applyProductionCsp(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
            "object-src 'none'; base-uri 'none'; frame-src 'none'"
        ]
      }
    })
  })
}

// Single instance lock: two compositors managing the same PTYs makes no sense.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    // The default Electron menu must be removed, not just hidden: it attaches
    // Ctrl+R (which reloads the renderer, wiping all terminal buffers),
    // Ctrl+W, and Ctrl+Q, and causes standalone Alt to focus the menu bar —
    // the exact key the compositor uses as a modifier.
    Menu.setApplicationMenu(null)

    // Before building any notification: on Windows without an explicit
    // Application User Model ID, toasts appear as "electron.app.Electron"
    // or fail to appear entirely.
    initNotifier()

    applyProductionCsp()
    registerIpc(ptys, live, () => mainWindow)
    installDevBridge(() => mainWindow)
    live.start()
    initUpdater((state) => mainWindow?.webContents.send('update:change', state))
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())

  // PTY processes are children of this process: without explicit termination,
  // orphaned PowerShell processes would linger after app exit.
  app.on('before-quit', () => {
    // Layout saving is debounced: at shutdown there may still be a pending
    // write, which must be flushed before quitting.
    flushLayout()
    live.stop()
    stopUpdater()
    ptys.killAll()
  })
}
