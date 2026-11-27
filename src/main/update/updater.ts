import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'

/**
 * Updates from GitHub releases.
 *
 * Three core design decisions:
 *
 * 1. DOWNLOAD automatically, but DO NOT install automatically. Installing
 *    requires restarting, and an unexpected restart would kill all active Claude
 *    sessions. Installation takes place when closing the app or when requested by the user.
 * 2. Portable builds CHECK but DO NOT download. A running .exe cannot replace
 *    itself, and the published automatic update asset is the installer, which
 *    would inadvertently convert a portable setup into an installed one. Knowing a
 *    new version exists is still useful, so checks run and the release download link is shown.
 * 3. In development mode everything is disabled, unless CM_UPDATE_DEV=1 is set.
 */

/**
 * Must match the `publish` block of electron-builder.yml. Used only to
 * compose release page URLs: the update feed channel itself is read by
 * electron-updater from app-update.yml generated from that same block.
 */
const RELEASES_URL = 'https://github.com/Tha-Nixo/ClaudeCodeManager/releases'

// electron-updater is CommonJS: direct destructuring fails
// within the main ESM bundle.
const { autoUpdater } = electronUpdater

/** Delay before initial update check to keep startup fast. */
const FIRST_CHECK_MS = 20_000
/** Checking once a day suffices for an application kept open long term. */
const INTERVAL_MS = 24 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle' }
let notify: ((s: UpdateState) => void) | null = null
let timer: NodeJS.Timeout | null = null

function setState(next: UpdateState): void {
  state = next
  notify?.(state)
}

/**
 * electron-builder sets PORTABLE_EXECUTABLE_DIR only for portable targets:
 * reliable way to distinguish portable mode from an NSIS installation.
 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

/**
 * In development mode the updater is normally disabled, which makes it hard
 * to verify: a broken update workflow goes unnoticed until needed.
 * Setting CM_UPDATE_DEV=1 enables it using app-update.yml from the latest build,
 * allowing channel verification. Has no effect in packaged builds.
 */
const devOverride = (): boolean => !app.isPackaged && process.env.CM_UPDATE_DEV === '1'

/** Release page URL to open when manual installation is required. */
function releasePage(version?: string): string {
  return version ? `${RELEASES_URL}/tag/v${version}` : `${RELEASES_URL}/latest`
}

/** Maximum length for release notes preview. */
const NOTES_LIMIT = 240

/**
 * Strips release notes down to plain text.
 *
 * GitHub returns notes as pre-rendered HTML. Passing raw HTML over IPC
 * introduces remote markup to the renderer: while not currently rendered as HTML,
 * using dangerouslySetInnerHTML in the future would introduce an injection vulnerability.
 * Only sanitized plain text should cross this boundary.
 */
function plainNotes(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined

  const text = raw
    // Block tags become spaces to prevent adjacent words from running together.
    .replace(/<\/(p|li|h\d|tr|div)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[m] ??
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return undefined
  return text.length > NOTES_LIMIT ? `${text.slice(0, NOTES_LIMIT).trimEnd()}…` : text
}

export function currentState(): UpdateState {
  return state
}

export function initUpdater(send: (s: UpdateState) => void): void {
  notify = send

  if (!app.isPackaged && !devOverride()) {
    setState({ status: 'unsupported', message: 'Updates disabled during development.' })
    return
  }

  // The portable build only checks: see the note at the top of this file.
  const manual = isPortable()

  autoUpdater.autoDownload = !manual
  autoUpdater.autoInstallOnAppQuit = !manual
  autoUpdater.logger = null

  if (devOverride()) {
    // Without this, electron-updater refuses to start outside a package.
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))

  autoUpdater.on('update-available', (info) =>
    setState(
      manual
        ? {
            status: 'available',
            version: info.version,
            releaseUrl: releasePage(info.version),
            notes: plainNotes(info.releaseNotes),
            message:
              'The portable build cannot self-update: download the new executable and replace the current file.'
          }
        : { status: 'downloading', version: info.version, percent: 0 }
    )
  )

  autoUpdater.on('update-not-available', () =>
    setState({ status: 'idle', checkedAt: Date.now() })
  )

  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', version: state.version, percent: Math.round(p.percent) })
  )

  autoUpdater.on('update-downloaded', (info) =>
    setState({ status: 'ready', version: info.version, notes: plainNotes(info.releaseNotes) })
  )

  autoUpdater.on('error', (err) =>
    // A failed update must not get in the way: it is noted and retried at the
    // next check. No modal dialog.
    setState({ status: 'error', message: err?.message || 'Update check failed.' })
  )

  timer = setTimeout(() => {
    void check()
    timer = setInterval(() => void check(), INTERVAL_MS)
  }, FIRST_CHECK_MS)
}

export async function check(): Promise<UpdateState> {
  if (state.status === 'unsupported') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setState({
      status: 'error',
      message: err instanceof Error ? err.message : 'Update check failed.'
    })
  }
  return state
}

/** Restarts and installs the update. Called only upon explicit user request. */
export function installNow(): void {
  if (state.status !== 'ready') return
  autoUpdater.quitAndInstall()
}

/** Manual download page URL when the application cannot self-update. */
export function releaseUrl(): string {
  return state.releaseUrl ?? releasePage()
}

export function stopUpdater(): void {
  if (timer) {
    clearTimeout(timer)
    clearInterval(timer)
    timer = null
  }
  notify = null
}
