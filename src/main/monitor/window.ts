import { join } from 'node:path'
import { BrowserWindow, app, screen } from 'electron'
import { readJson, writeJsonAtomic } from '../store/config'

/**
 * Finestra staccata del pannello di monitoraggio.
 *
 * Piccola, senza cornice, sempre in primo piano: serve a tenere d'occhio le
 * sessioni mentre si lavora in un'altra applicazione, tipicamente su un
 * secondo schermo.
 *
 * Carica lo STESSO bundle del renderer con `#monitor` in coda. Un secondo
 * punto d'ingresso in electron.vite.config.ts sarebbe più "pulito" sulla
 * carta, ma raddoppierebbe la build e obbligherebbe a duplicare il montaggio
 * del tema; l'ancora non tocca il percorso del file, quindi funziona identica
 * col server di sviluppo e con `file://`.
 */

let monitorWindow: BrowserWindow | null = null

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_SIZE = { width: 380, height: 520 }

function boundsPath(): string {
  return join(app.getPath('userData'), 'monitor-window.json')
}

/**
 * Posizione salvata, ma solo se ricade ancora dentro uno schermo esistente.
 *
 * Un portatile scollegato dal monitor esterno lascerebbe altrimenti la
 * finestra a coordinate che non appartengono più a nessun display: si
 * aprirebbe fuori dallo schermo, invisibile e irraggiungibile.
 */
function restoreBounds(): Bounds | null {
  const saved = readJson<Bounds>(boundsPath())
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return null

  const visible = screen.getAllDisplays().some((display) => {
    const a = display.workArea
    // Basta che un angolo sia dentro: una finestra a cavallo di due schermi è
    // legittima e non va spostata.
    return (
      saved.x + saved.width > a.x &&
      saved.x < a.x + a.width &&
      saved.y + saved.height > a.y &&
      saved.y < a.y + a.height
    )
  })

  return visible ? saved : null
}

function rememberBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return
  writeJsonAtomic(boundsPath(), win.getBounds())
}

export function isMonitorOpen(): boolean {
  return monitorWindow !== null && !monitorWindow.isDestroyed()
}

/** Apre la finestra staccata, o la porta in primo piano se c'è già. */
export function openMonitorWindow(isDev: boolean): void {
  if (isMonitorOpen()) {
    monitorWindow?.show()
    monitorWindow?.focus()
    return
  }

  const saved = restoreBounds()

  monitorWindow = new BrowserWindow({
    ...DEFAULT_SIZE,
    ...(saved ?? {}),
    show: false,
    frame: false,
    // Sopra le finestre normali ma sotto i pannelli di sistema: 'floating' è
    // il livello giusto. 'screen-saver' starebbe anche sopra le notifiche,
    // che è invadente per un pannello informativo.
    alwaysOnTop: true,
    skipTaskbar: false,
    minWidth: 280,
    minHeight: 220,
    backgroundColor: '#1F1E1D',
    title: 'ClaudeManager — monitor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  monitorWindow.setAlwaysOnTop(true, 'floating')

  // Il <title> del documento sovrascriverebbe quello impostato qui, e le due
  // finestre finirebbero omonime: indistinguibili nella barra delle
  // applicazioni, e non più raggiungibili dai test.
  monitorWindow.on('page-title-updated', (event) => event.preventDefault())

  monitorWindow.on('ready-to-show', () => monitorWindow?.show())
  monitorWindow.on('moved', () => monitorWindow && rememberBounds(monitorWindow))
  monitorWindow.on('resized', () => monitorWindow && rememberBounds(monitorWindow))
  monitorWindow.on('close', () => monitorWindow && rememberBounds(monitorWindow))
  monitorWindow.on('closed', () => {
    monitorWindow = null
  })

  // Stesse protezioni della finestra principale: niente navigazione, niente
  // apertura di finestre nuove.
  monitorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  monitorWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void monitorWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#monitor`)
  } else {
    void monitorWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'monitor' })
  }
}

export function closeMonitorWindow(): void {
  if (isMonitorOpen()) monitorWindow?.close()
}
