import { BrowserWindow, type WebContents } from 'electron'
import type { MonitorPane, MonitorState } from '@shared/types'
import { sessionUsage, summarize } from '../usage/scanner'

/**
 * Monitoring panel state.
 *
 * The panel lives in two containers — the drawer inside the main window
 * and the detached window — and the two do not share memory. The state
 * therefore resides in main, which is the only point visible to both.
 *
 * Main, however, knows nothing about panes: those are React state in the
 * main renderer, which publishes them here on every change. This is the only
 * sensible architecture — moving the compositor tree into main just to let
 * a tiny window read two numbers would be disproportionate.
 */

/** Update interval while an observer is active. */
const TICK_MS = 2_000

/** Last list published by the main renderer. */
let panes: MonitorPane[] = []

/**
 * Active observers, tracked by identity rather than simple count.
 *
 * A simple counter gets corrupted on the first edge case — a window closed
 * without unsubscribing, a reloaded renderer, a crash — leaving an orphaned
 * timer re-reading transcripts every two seconds for nobody.
 * Tracking WebContents allows verifying if they are still alive,
 * and accounting self-corrects.
 */
const watchers = new Set<WebContents>()
let timer: NodeJS.Timeout | null = null

/** Sends an event to every window, not just the main one. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Composes the complete state by joining panes with transcript statistics.
 *
 * Scanning is incremental and has its own rate limiter, so calling it
 * every two seconds costs almost nothing when nothing has changed.
 */
export function currentState(): MonitorState {
  const usage = sessionUsage()
  const today = summarize()

  return {
    panes: panes.map((pane) => ({
      ...pane,
      usage: pane.claudeSessionId ? usage[pane.claudeSessionId] : undefined
    })),
    todayCost: today.todayCost,
    todayTokens: today.todayTokens,
    updatedAt: Date.now()
  }
}

/** Stops the timer when nobody is watching; starts it when needed. */
function syncTimer(): void {
  for (const wc of watchers) if (wc.isDestroyed()) watchers.delete(wc)

  if (watchers.size > 0 && !timer) {
    timer = setInterval(() => {
      // A renderer may terminate between ticks without unsubscribing.
      for (const wc of watchers) if (wc.isDestroyed()) watchers.delete(wc)
      if (watchers.size === 0) return syncTimer()
      broadcast('monitor:state', currentState())
    }, TICK_MS)
  } else if (watchers.size === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** The main renderer publishes its panes. */
export function publishPanes(next: MonitorPane[]): void {
  panes = Array.isArray(next) ? next : []
  // Change is immediate and visible: do not wait for next tick.
  if (watchers.size > 0) broadcast('monitor:state', currentState())
}

export function subscribe(sender: WebContents): MonitorState {
  watchers.add(sender)
  // A renderer reload does not go through unsubscribe: remove here.
  sender.once('destroyed', () => {
    watchers.delete(sender)
    syncTimer()
  })
  syncTimer()
  return currentState()
}

export function unsubscribe(sender: WebContents): void {
  watchers.delete(sender)
  syncTimer()
}
