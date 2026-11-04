import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/**
 * Development bridge to automate and take screenshots of the app externally.
 *
 * Used to verify the compositor without relying on OS window focus:
 * events are injected directly into the renderer and screen captures use
 * webContents.capturePage(), so user focus is not stolen and nothing outside
 * the app is captured.
 *
 * Disabled by default and omitted from packaged builds: only enabled by
 * setting CM_DEV_BRIDGE=1 during development.
 *
 * Protocol: JSONL lines written to <userData>/dev-bridge/in.jsonl,
 * one command per line; the file is consumed and deleted.
 */

/** Subset of modifiers accepted by webContents.sendInputEvent. */
type InputModifier = 'shift' | 'control' | 'alt' | 'meta'

/**
 * Window to which the command should be dispatched.
 *
 * Since the detachable panel exists, there are two windows; an untested window
 * cannot be photographed or queried. Targeted by title, the only stable identifier
 * across launches; defaults to the main window when omitted.
 */
type WindowTarget = { window?: string }

type Command = WindowTarget &
  (
    | { type: 'key'; key: string; modifiers?: InputModifier[]; repeat?: number }
    | { type: 'text'; text: string }
    | { type: 'click'; x: number; y: number }
    | { type: 'drag'; from: { x: number; y: number }; to: { x: number; y: number }; steps?: number }
    | { type: 'shot'; path: string }
    | { type: 'eval'; js: string; path: string }
  )

const POLL_MS = 250

export function installDevBridge(getWindow: () => BrowserWindow | null): void {
  if (app.isPackaged || process.env.CM_DEV_BRIDGE !== '1') return

  const dir = join(app.getPath('userData'), 'dev-bridge')
  mkdirSync(dir, { recursive: true })
  const inbox = join(dir, 'in.jsonl')
  const ack = join(dir, 'done.txt')

  setInterval(() => {
    if (!existsSync(inbox)) return

    let lines: string[]
    try {
      // PowerShell 5.1 writes UTF-8 with BOM: without stripping it,
      // the initial JSON.parse fails and the command is silently discarded.
      lines = readFileSync(inbox, 'utf8')
        .replace(/^﻿/, '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    } catch {
      return
    }
    try {
      unlinkSync(inbox)
    } catch {
      return
    }

    void run(lines, getWindow).then(() => {
      writeFileSync(ack, String(Date.now()), 'utf8')
    })
  }, POLL_MS)
}

async function run(lines: string[], getWindow: () => BrowserWindow | null): Promise<void> {
  for (const line of lines) {
    let cmd: Command
    try {
      cmd = JSON.parse(line) as Command
    } catch {
      continue
    }

    const win = resolveWindow(cmd.window, getWindow)
    // A requested window that cannot be found indicates a mismatched test:
    // skip the command rather than dispatching it to the wrong window.
    if (!win) continue
    const wc = win.webContents

    switch (cmd.type) {
      case 'key': {
        const times = cmd.repeat ?? 1
        for (let i = 0; i < times; i++) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: cmd.key, modifiers: cmd.modifiers ?? [] })
          wc.sendInputEvent({ type: 'keyUp', keyCode: cmd.key, modifiers: cmd.modifiers ?? [] })
          await delay(120)
        }
        break
      }
      case 'text': {
        for (const ch of cmd.text) {
          wc.sendInputEvent({ type: 'char', keyCode: ch })
          await delay(20)
        }
        break
      }
      case 'click': {
        wc.sendInputEvent({ type: 'mouseDown', x: cmd.x, y: cmd.y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x: cmd.x, y: cmd.y, button: 'left', clickCount: 1 })
        await delay(120)
        break
      }
      case 'drag': {
        // Dragging must be simulated in steps: the handler reacts to pointermove,
        // and an instantaneous jump from origin to destination would never trigger
        // the gesture threshold separating a click from a drag.
        const steps = Math.max(2, cmd.steps ?? 12)
        wc.sendInputEvent({ type: 'mouseDown', x: cmd.from.x, y: cmd.from.y, button: 'left', clickCount: 1 })
        await delay(40)
        for (let i = 1; i <= steps; i++) {
          const t = i / steps
          wc.sendInputEvent({
            type: 'mouseMove',
            x: Math.round(cmd.from.x + (cmd.to.x - cmd.from.x) * t),
            y: Math.round(cmd.from.y + (cmd.to.y - cmd.from.y) * t)
          })
          await delay(25)
        }
        await delay(80)
        wc.sendInputEvent({ type: 'mouseUp', x: cmd.to.x, y: cmd.to.y, button: 'left', clickCount: 1 })
        await delay(120)
        break
      }
      case 'shot': {
        const image = await wc.capturePage()
        writeFileSync(cmd.path, image.toPNG())
        break
      }
      case 'eval': {
        try {
          const value: unknown = await wc.executeJavaScript(cmd.js, true)
          writeFileSync(cmd.path, JSON.stringify(value, null, 2) ?? 'undefined', 'utf8')
        } catch (err) {
          writeFileSync(cmd.path, `ERROR: ${String(err)}`, 'utf8')
        }
        break
      }
    }
  }
}

/** Window whose title contains the specified substring, or main window. */
function resolveWindow(
  match: string | undefined,
  getWindow: () => BrowserWindow | null
): BrowserWindow | null {
  if (!match) return getWindow()
  const needle = match.toLowerCase()
  return (
    BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.getTitle().toLowerCase().includes(needle)
    ) ?? null
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
