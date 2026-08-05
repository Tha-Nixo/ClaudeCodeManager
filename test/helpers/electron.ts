import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Finto modulo 'electron', sostituito al vero al momento del bundle.
 *
 * Quasi tutti i moduli del processo principale chiamano
 * `app.getPath('userData')` per comporre un percorso. Senza questo stub non si
 * potrebbero provare in Node puro, e l'unica alternativa sarebbe avviare
 * Electron per ogni caso limite — molto piu' lento, e senza possibilita' di
 * isolare uno stato di partenza.
 *
 * `userData` punta a una cartella temporanea NUOVA ad ogni esecuzione, cosi'
 * i test non toccano mai la configurazione reale di chi li lancia.
 */

const userData = mkdtempSync(join(tmpdir(), 'cm-test-'))

export const app = {
  getPath: (name: string): string => (name === 'userData' ? userData : tmpdir()),
  getVersion: (): string => '0.0.0-test',
  isPackaged: false,
  setAppUserModelId: (): void => {},
  requestSingleInstanceLock: (): boolean => true,
  on: (): void => {},
  once: (): void => {},
  whenReady: (): Promise<void> => Promise.resolve(),
  quit: (): void => {}
}

/** Radice temporanea di questa esecuzione, per ispezionare cio' che e' stato scritto. */
export const __userData = userData

export const ipcMain = {
  handle: (): void => {},
  on: (): void => {},
  removeHandler: (): void => {}
}

export const shell = {
  openPath: (): Promise<string> => Promise.resolve(''),
  openExternal: (): Promise<void> => Promise.resolve()
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  webContents = { send: (): void => {} }
  isDestroyed(): boolean {
    return false
  }
  isFocused(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  flashFrame(): void {}
}

export const screen = {
  getAllDisplays: (): { workArea: { x: number; y: number; width: number; height: number } }[] => [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  ]
}

export class Notification {
  static isSupported(): boolean {
    return false
  }
  show(): void {}
  on(): void {}
}

export const Menu = { setApplicationMenu: (): void => {} }
export const session = { defaultSession: { webRequest: { onHeadersReceived: (): void => {} } } }
export const nativeImage = { createFromPath: (): unknown => ({ isEmpty: () => true }) }

export default { app, ipcMain, shell, BrowserWindow, screen, Notification, Menu, session }
