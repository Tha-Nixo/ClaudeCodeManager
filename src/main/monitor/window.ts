import { join } from 'node:path'
import { BrowserWindow, app, screen } from 'electron'
import { readJson, writeJsonAtomic } from '../store/config'

/**
 * Detached window for the monitoring panel.
 *
 * Compact, frameless, always-on-top: keeps an eye on sessions
 * while working in another application, typically on a secondary display.
 *
 * Loads the SAME renderer bundle with `#monitor` appended. A separate
 * entrypoint in electron.vite.config.ts would look cleaner on paper,
 * but would double build times and require duplicating theme mounting;
 * the URL hash does not alter the file path, so it functions identically
 * with the dev server and with `file://`.
 */

let monitorWindow: BrowserWindow | null = null

/**
 * Notifies the rest of the application when the detached window appears or disappears.
 *
 * Previously the announcement only fired from the two commands "detach" and "reattach".
 * Closing the window directly — with the close button or Alt+F4 —
 * triggered nothing, leaving the drawer displaying "Panel is in a separate window"
 * referencing a window that was no longer there.
 */
let onDetachedChange: ((detached: boolean) => void) | null = null

export function setDetachedListener(cb: (detached: boolean) => void): void {
  onDetachedChange = cb
}

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
 * Saved bounds, but only if they still intersect an existing display.
 *
 * A laptop disconnected from an external monitor would otherwise place the
 * window at coordinates that no longer belong to any display: it would open
 * off-screen, invisible and unreachable.
 */
function restoreBounds(): Bounds | null {
  const saved = readJson<Bounds>(boundsPath())
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return null

  const visible = screen.getAllDisplays().some((display) => {
    const a = display.workArea
    // As long as one corner intersects: a window spanning two monitors is
    // valid and should not be repositioned.
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

/** Opens the detached window, or brings it forward if already open. */
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
    // Above regular windows but below system overlays: 'floating' is the
    // appropriate level. 'screen-saver' would sit above notifications,
    // which is intrusive for an informative panel.
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

  // The document <title> would overwrite the one configured here, making both
  // windows eponymous: indistinguishable in the taskbar and difficult
  // to target in tests.
  monitorWindow.on('page-title-updated', (event) => event.preventDefault())

  monitorWindow.on('ready-to-show', () => monitorWindow?.show())
  onDetachedChange?.(true)
  monitorWindow.on('moved', () => monitorWindow && rememberBounds(monitorWindow))
  monitorWindow.on('resized', () => monitorWindow && rememberBounds(monitorWindow))
  monitorWindow.on('close', () => monitorWindow && rememberBounds(monitorWindow))
  monitorWindow.on('closed', () => {
    monitorWindow = null
    // Direct closing is also a state transition: without this notification,
    // the drawer would still believe the panel is detached.
    onDetachedChange?.(false)
  })

  // Same protections as the main window: no navigation, no new window opening.
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
