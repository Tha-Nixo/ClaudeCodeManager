import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Notification, app } from 'electron'
import type { LiveSession, MonitorPane } from '@shared/types'

/**
 * Notifies when a session transitions to waiting for user input.
 *
 * Essential for multi-session workflows: with multiple open panes, users
 * cannot monitor every terminal constantly. The app reads exact session state
 * from Claude Code session registry files via watcher.
 *
 * Three core rules keep notifications useful and non-intrusive:
 *
 * 1. Only notify on TRANSITION to "waiting for input", not repeatedly.
 * 2. Suppress notifications when app window is focused and visible.
 * 3. Only notify for sessions belonging to active panes in this app.
 */

/** Application User Model ID for Windows toast notifications. */
const APP_USER_MODEL_ID = 'dev.nixo.claudemanager'

/** Previous state per session to detect state transitions. */
const previous = new Map<string, RememberedSession>()

/**
 * Cached session state with consecutive missing cycle counter.
 *
 * Claude Code rewrites registry files on state changes, causing transient 1-cycle gaps.
 * Retaining memory across a few misses avoids false first-sighting suppression.
 */
interface RememberedSession {
  status: string
  missing: number
}

/** Number of consecutive absent cycles allowed before eviction. */
const FORGET_AFTER_MISSES = 5
/** Known panes published from renderer on layout updates. */
let known: MonitorPane[] = []
let enabled = true

export function initNotifier(): void {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

export function setNotificationsEnabled(value: boolean): void {
  enabled = value
}

export function setKnownPanes(panes: MonitorPane[]): void {
  known = Array.isArray(panes) ? panes : []
}

export interface PendingNotice {
  pane: MonitorPane
  live: LiveSession
}

/**
 * Evaluates pending notices and updates historical state cache.
 * Isolated pure logic enabling unit tests without Electron runtime.
 */
export function decideNotices(
  sessions: LiveSession[],
  panes: MonitorPane[],
  seenBefore: Map<string, RememberedSession>
): PendingNotice[] {
  const present = new Set<string>()
  const out: PendingNotice[] = []

  for (const live of sessions) {
    present.add(live.sessionId)
    const before = seenBefore.get(live.sessionId)
    const now = live.status ?? 'unknown'
    seenBefore.set(live.sessionId, { status: now, missing: 0 })

    if (before === undefined || before.status === now || now !== 'waiting') continue

    const pane = panes.find((p) => p.claudeSessionId === live.sessionId)
    if (pane) out.push({ pane, live })
  }

  for (const [id, record] of [...seenBefore.entries()]) {
    if (present.has(id)) continue
    if (record.missing + 1 >= FORGET_AFTER_MISSES) seenBefore.delete(id)
    else seenBefore.set(id, { ...record, missing: record.missing + 1 })
  }

  return out
}

/** Compares registry with cached state and triggers alerts on transitions. */
export function onLiveChange(sessions: LiveSession[], getWindow: () => BrowserWindow | null): void {
  const waiting = decideNotices(sessions, known, previous)
  if (waiting.length === 0) return

  const win = getWindow()
  const visible = Boolean(win && win.isFocused() && !win.isMinimized())

  traceForTests(waiting, visible)
  if (visible) return

  notify(waiting, win)
}

function notify(waiting: PendingNotice[], win: BrowserWindow | null): void {
  // Flash taskbar icon regardless of OS toast notification settings
  if (win && !win.isDestroyed()) win.flashFrame(true)

  if (!enabled || !Notification.isSupported()) return

  // Group multiple waiting sessions into single notification
  const title =
    waiting.length === 1
      ? `${waiting[0].pane.label} is waiting for input`
      : `${waiting.length} sessions waiting for input`

  const body =
    waiting.length === 1
      ? (waiting[0].live.waitingFor ?? waiting[0].pane.where)
      : waiting.map((w) => w.pane.label).join(' · ')

  const notification = new Notification({ title, body, silent: false })

  notification.on('click', () => {
    const target = getMainWindow(win)
    if (!target) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    target.flashFrame(false)
    target.webContents.send('notify:focus-pane', waiting[0].pane.paneId)
  })

  notification.show()
}

/** Dev-bridge trace log for automated end-to-end testing. */
function traceForTests(waiting: PendingNotice[], suppressed: boolean): void {
  if (process.env.CM_DEV_BRIDGE !== '1') return
  try {
    const outcome = suppressed ? 'SUPPRESSED(window visible)' : 'SHOWN'
    const who = waiting.map((w) => w.pane.paneId.slice(0, 8)).join(',')
    appendFileSync(
      join(app.getPath('userData'), 'dev-bridge', 'notifications.log'),
      `${new Date().toISOString()} ${outcome} ${who}\n`,
      'utf8'
    )
  } catch {
    // Ignore trace failure
  }
}

function getMainWindow(fallback: BrowserWindow | null): BrowserWindow | null {
  if (fallback && !fallback.isDestroyed()) return fallback
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

export function clearAttention(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.flashFrame(false)
}
