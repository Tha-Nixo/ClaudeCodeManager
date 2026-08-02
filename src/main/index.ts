import { join } from 'node:path'
import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { LiveSessions } from './claude/live'
import { installDevBridge } from './dev/bridge'
import { registerIpc } from './ipc'
import { PtyManager } from './pty/manager'
import { flushLayout } from './store/layout'
import { initUpdater, stopUpdater } from './update/updater'

const isDev = !app.isPackaged
/** In sviluppo si può partire in finestra: CM_WINDOWED=1 npm run dev */
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

  // I link esterni non devono mai navigare dentro la finestra dell'app, e
  // vanno consegnati al sistema solo se sono http/https: shell.openExternal
  // apre anche file:, ms-settings: e qualunque altro schema registrato, e
  // l'URL arriva dal renderer, che non è una fonte fidata.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url)
      }
    } catch {
      // URL malformato: si ignora.
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  // Un renderer che riparte (ricarica in sviluppo, crash del processo) perde
  // ogni riferimento ai PTY: resterebbero processi vivi che nessuna interfaccia
  // può più raggiungere né chiudere.
  // Si uccide all'INIZIO del nuovo caricamento, non alla fine: così i vecchi
  // processi sono già spariti quando il nuovo renderer inizia a ricrearne.
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
    // Il menu predefinito di Electron va rimosso, non nascosto: porta con sé
    // Ctrl+R (ricarica il renderer, azzerando tutti i buffer dei terminali),
    // Ctrl+W e Ctrl+Q, e fa sì che il solo Alt attivi la barra dei menu —
    // cioè proprio il tasto che il compositor usa come modificatore.
    Menu.setApplicationMenu(null)

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

  // I processi PTY sono figli di questo processo: senza kill esplicito
  // resterebbero PowerShell orfani dopo la chiusura dell'app.
  app.on('before-quit', () => {
    // Il salvataggio del layout è accorpato: alla chiusura può esserci una
    // scrittura ancora in attesa, e va forzata prima di uscire.
    flushLayout()
    live.stop()
    stopUpdater()
    ptys.killAll()
  })
}
