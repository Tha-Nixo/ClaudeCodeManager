import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { registerIpc } from './ipc'
import { PtyManager } from './pty/manager'

const isDev = !app.isPackaged
/** In sviluppo si può partire in finestra: CM_WINDOWED=1 npm run dev */
const startWindowed = isDev && process.env.CM_WINDOWED === '1'

let mainWindow: BrowserWindow | null = null
const ptys = new PtyManager()

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

  // I link esterni non devono mai navigare dentro la finestra dell'app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * CSP applicata solo in produzione: in sviluppo Vite ha bisogno di eval e di
 * una connessione websocket per l'HMR, che una policy stretta bloccherebbe.
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

// Una sola istanza: due compositor che gestiscono gli stessi PTY non ha senso.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    applyProductionCsp()
    registerIpc(ptys, () => mainWindow)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())

  // I processi PTY sono figli di questo processo: senza kill esplicito
  // resterebbero PowerShell orfani dopo la chiusura dell'app.
  app.on('before-quit', () => ptys.killAll())
}
