import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Notification, app } from 'electron'
import type { LiveSession, MonitorPane } from '@shared/types'

/**
 * Notifies when a session starts waiting for input, and when it finishes its
 * turn (#24).
 *
 * This is the whole point of a multi-session manager: with six panes open you
 * cannot watch them all, and the app already knows the exact moment one stops
 * to wait. It reads it from the registry Claude Code maintains, with a watcher
 * and a 120 ms delay. The most frequent reason to look at a pane is that
 * Claude finished (busy -> idle); the permission dialog (-> waiting) is the
 * other one.
 *
 * Three rules keep this useful instead of annoying:
 *
 * 1. Notify only on the TRANSITION, not for as long as the state lasts. The
 *    registry is rewritten often, and notifying on every rewrite would produce
 *    a burst for a single wait. A finished turn must also stay idle for
 *    FINISH_DEBOUNCE_MS, so a short idle between two steps cannot trigger it.
 * 2. No notification while the window has focus: whoever is looking at the
 *    app already sees the dot change color.
 * 3. Only sessions that belong to a pane. The registry holds every live Claude
 *    Code on the machine, including sessions opened in another terminal:
 *    alerting for those would be intrusive.
 */

/**
 * Application User Model ID for Windows.
 *
 * Without it, notifications show up attributed to "electron.app.Electron", or
 * do not show up at all in the packaged app. It must match electron-builder's
 * appId, which is what the installer registers.
 */
const APP_USER_MODEL_ID = 'dev.nixo.claudemanager'

/** Previous state per session to detect state transitions. */
const previous = new Map<string, RememberedSession>()

/**
 * Remembered state of a session, with how many consecutive polls it has been
 * missing.
 *
 * The count is not a detail: the registry is REWRITTEN when a session changes
 * status, and for an instant the file may not be there. If the session were
 * forgotten on the first missing poll, its return with status 'waiting' would
 * look like a first sighting and the alert would not go out, exactly at the
 * moment it is most likely to be needed.
 */
export interface RememberedSession {
  status: string
  missing: number
  /**
   * When the session went from busy to idle, while that finish has not been
   * announced yet. Cleared by any other status, so an idle that does not last
   * FINISH_DEBOUNCE_MS never turns into an alert.
   */
  finishedAt?: number
}

/** Number of consecutive absent cycles allowed before eviction. */
const FORGET_AFTER_MISSES = 5
/** How long busy -> idle must hold before it counts as a finished turn. */
export const FINISH_DEBOUNCE_MS = 1500
/** Known panes published from renderer on layout updates. */
let known: MonitorPane[] = []
let enabled = true
let finishEnabled = true
let finishTimer: NodeJS.Timeout | null = null

export function initNotifier(): void {
  // It must be set before building any Notification.
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

export function setNotificationsEnabled(value: boolean): void {
  enabled = value
}

/** "Notify when a session finishes": off means no alert at all, not even a flash. */
export function setFinishNotificationsEnabled(value: boolean): void {
  finishEnabled = value
}

export function setKnownPanes(panes: MonitorPane[]): void {
  known = Array.isArray(panes) ? panes : []
}

export interface PendingNotice {
  kind: 'waiting' | 'finished'
  pane: MonitorPane
  /** What the session waits for (waiting only): shown as the toast body. */
  detail: string | null
}

/**
 * Decides who deserves an alert, and updates the previous state.
 *
 * Kept apart from the side effect because all the logic that can go wrong
 * lives here (transitions, first sighting, belonging to a pane, cleanup),
 * while showing the notification is one line. This way it can be tested
 * without Electron, instead of having to trust it.
 */
export function decideNotices(
  sessions: LiveSession[],
  panes: MonitorPane[],
  seenBefore: Map<string, RememberedSession>,
  at = Date.now()
): PendingNotice[] {
  const present = new Set<string>()
  const out: PendingNotice[] = []

  for (const live of sessions) {
    present.add(live.sessionId)
    const before = seenBefore.get(live.sessionId)
    const now = live.status ?? 'unknown'

    // A finish is remembered while the session stays idle, and forgotten as
    // soon as it does anything else. The alert itself waits for dueFinished().
    let finishedAt: number | undefined
    if (before !== undefined && now === 'idle') {
      if (before.status === 'busy') finishedAt = at
      else if (before.status === 'idle') finishedAt = before.finishedAt
    }
    seenBefore.set(
      live.sessionId,
      finishedAt === undefined ? { status: now, missing: 0 } : { status: now, missing: 0, finishedAt }
    )

    // Only the transition, and only toward waiting. An undefined `before` means a
    // first sighting: when the app starts every session would be "new", and a
    // burst of notifications would open for states the user already knows.
    if (before === undefined || before.status === now || now !== 'waiting') continue

    const pane = panes.find((p) => p.claudeSessionId === live.sessionId)
    if (pane) out.push({ kind: 'waiting', pane, detail: live.waitingFor ?? null })
  }

  // Sessions that disappeared are not forgotten at once: the registry is
  // rewritten exactly when the status changes, and a one-poll absence is
  // normal. Forgetting at once made the return look like a first sighting,
  // and the alert did not go out.
  // A pending finish is dropped too: a session that went away (/exit) right
  // after its turn has nothing left to announce.
  for (const [id, record] of [...seenBefore.entries()]) {
    if (present.has(id)) continue
    if (record.missing + 1 >= FORGET_AFTER_MISSES) seenBefore.delete(id)
    else seenBefore.set(id, { status: record.status, missing: record.missing + 1 })
  }

  return out
}

/**
 * Finished turns whose idle has lasted FINISH_DEBOUNCE_MS, for managed panes
 * only. Each finish is announced once: its mark is cleared here.
 */
export function dueFinished(
  panes: MonitorPane[],
  seenBefore: Map<string, RememberedSession>,
  at = Date.now()
): PendingNotice[] {
  const out: PendingNotice[] = []
  for (const [id, record] of seenBefore) {
    if (record.finishedAt === undefined || record.missing > 0) continue
    if (at - record.finishedAt < FINISH_DEBOUNCE_MS) continue
    seenBefore.set(id, { status: record.status, missing: record.missing })
    const pane = panes.find((p) => p.claudeSessionId === id)
    if (pane) out.push({ kind: 'finished', pane, detail: null })
  }
  return out
}

/** Earliest moment a pending finish becomes due, or null if none is pending. */
function nextFinishDue(seenBefore: Map<string, RememberedSession>): number | null {
  let next: number | null = null
  for (const record of seenBefore.values()) {
    if (record.finishedAt === undefined || record.missing > 0) continue
    const due = record.finishedAt + FINISH_DEBOUNCE_MS
    if (next === null || due < next) next = due
  }
  return next
}

/**
 * Compares the registry with the previous one and alerts on transitions.
 *
 * Called on every registry change, not on a timer: the source is already
 * event-based.
 */
export function onLiveChange(sessions: LiveSession[], getWindow: () => BrowserWindow | null): void {
  const waiting = decideNotices(sessions, known, previous)
  if (waiting.length > 0) deliver(waiting, getWindow)
  scheduleFinishCheck(getWindow)
}

/**
 * A finished turn is announced only after its idle has lasted, so it needs a
 * timer: the registry does not change again while a session sits idle.
 */
function scheduleFinishCheck(getWindow: () => BrowserWindow | null): void {
  if (finishTimer) clearTimeout(finishTimer)
  finishTimer = null
  const due = nextFinishDue(previous)
  if (due === null) return
  finishTimer = setTimeout(() => {
    finishTimer = null
    const finished = dueFinished(known, previous)
    if (finished.length > 0 && finishEnabled) deliver(finished, getWindow)
    scheduleFinishCheck(getWindow)
  }, Math.max(0, due - Date.now()))
}

function deliver(notices: PendingNotice[], getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  // Whoever is looking at the app already sees the dot change color: a system
  // notification on top of the window that triggered it is just noise. A
  // minimized window shows nothing, though, even if the system still considers
  // it active: it is treated as not being watched.
  const visible = Boolean(win && win.isFocused() && !win.isMinimized())

  traceForTests(notices, visible)
  if (visible) return

  notify(notices, win)
}

/** Toast title and body: several notices of one kind become a single toast. */
export function noticeText(notices: PendingNotice[]): { title: string; body: string } {
  const first = notices[0]
  const finished = first.kind === 'finished'
  if (notices.length === 1) {
    return {
      title: finished
        ? `${first.pane.label} finished`
        : `${first.pane.label} is waiting for input`,
      body: finished ? first.pane.where : (first.detail ?? first.pane.where)
    }
  }
  return {
    title: finished
      ? `${notices.length} sessions finished`
      : `${notices.length} sessions waiting for input`,
    body: notices.map((n) => n.pane.label).join(' · ')
  }
}

function notify(notices: PendingNotice[], win: BrowserWindow | null): void {
  // The taskbar flash happens anyway: it stays visible even when system
  // notifications are turned off or suppressed by Windows Focus Assist.
  if (win && !win.isDestroyed()) win.flashFrame(true)

  // notifyOnWaiting turns off the waiting toast only; finished notices only
  // get here when notifyOnFinish is on.
  const toastsOn = notices[0].kind === 'finished' ? finishEnabled : enabled
  if (!toastsOn || !Notification.isSupported()) return

  // Several sessions at once become a single alert: three stacked
  // notifications for one event are worse than one that sums them up.
  const { title, body } = noticeText(notices)
  const notification = new Notification({ title, body, silent: false })

  // The click leads to the app and to the right pane: without it the alert
  // says something is waiting but leaves the user to go and find it.
  notification.on('click', () => {
    const target = getMainWindow(win)
    if (!target) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    target.flashFrame(false)
    target.webContents.send('notify:focus-pane', notices[0].pane.paneId)
  })

  notification.show()
}

/**
 * Leaves a trace of the alerts shown, for end-to-end tests.
 *
 * A Windows notification cannot be observed from outside without capturing
 * the whole screen, and Electron's main process does not deliver standard
 * output to a file on Windows. The development bridge is the test bench, so
 * the trace goes in its folder. In the packaged app the variable is never set
 * and nothing is written.
 */
function traceForTests(notices: PendingNotice[], suppressed: boolean): void {
  if (process.env.CM_DEV_BRIDGE !== '1') return
  try {
    const outcome = suppressed ? 'SUPPRESSED(window visible)' : 'SHOWN'
    const who = notices.map((n) => n.pane.paneId.slice(0, 8)).join(',')
    appendFileSync(
      join(app.getPath('userData'), 'dev-bridge', 'notifications.log'),
      `${new Date().toISOString()} ${outcome} ${notices[0].kind} ${who}\n`,
      'utf8'
    )
  } catch {
  // A missed trace must not stop the real alert.
  }
}

/** The main window stays the target even when focus is elsewhere. */
function getMainWindow(fallback: BrowserWindow | null): BrowserWindow | null {
  if (fallback && !fallback.isDestroyed()) return fallback
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

/** Stops the flashing when the user comes back to the app. */
export function clearAttention(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.flashFrame(false)
}
