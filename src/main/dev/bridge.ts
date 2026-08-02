import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/**
 * Ponte di sviluppo per pilotare e fotografare l'app da fuori.
 *
 * Serve a verificare il compositor senza dipendere dal focus del sistema
 * operativo: gli eventi vengono iniettati direttamente nel renderer e la
 * cattura passa da webContents.capturePage(), quindi non si ruba il fuoco
 * all'utente e non si fotografa nulla al di fuori dell'app.
 *
 * Disattivato di default e comunque assente nel pacchetto: si abilita solo
 * impostando CM_DEV_BRIDGE=1 in sviluppo.
 *
 * Protocollo: si scrive un file JSONL in <userData>/dev-bridge/in.jsonl, una
 * riga per comando; il file viene consumato ed eliminato.
 */

/** Sottoinsieme dei modificatori accettati da webContents.sendInputEvent. */
type InputModifier = 'shift' | 'control' | 'alt' | 'meta'

/**
 * Finestra a cui inviare il comando.
 *
 * Da quando esiste il pannello staccabile le finestre sono due, e una che
 * non si può né fotografare né interrogare è una che nessun test copre.
 * Si indica per titolo, che è l'unico identificatore stabile fra un avvio e
 * l'altro; assente, vale la finestra principale.
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
      // PowerShell 5.1 scrive UTF-8 CON BOM: senza toglierlo il primo
      // JSON.parse fallisce e il comando viene scartato in silenzio.
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
    // Una finestra chiesta e non trovata è un test che sta misurando altro:
    // meglio saltare il comando che dirigerlo alla finestra sbagliata.
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
        // Il trascinamento va simulato a passi: il gestore reagisce ai
        // pointermove, e un salto diretto dall'origine alla destinazione non
        // passerebbe mai per la soglia che distingue un clic da un gesto.
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
          writeFileSync(cmd.path, `ERRORE: ${String(err)}`, 'utf8')
        }
        break
      }
    }
  }
}

/** Finestra il cui titolo contiene il frammento indicato, o la principale. */
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
