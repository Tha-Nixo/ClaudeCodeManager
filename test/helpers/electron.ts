import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Mock 'electron' module, substituted for the real one at bundle time.
 *
 * Most main process modules call `app.getPath('userData')` to build paths.
 * Without this stub, they couldn't be tested in pure Node, and the only
 * alternative would be launching Electron for every edge case — much slower,
 * and without the ability to cleanly isolate starting state.
 *
 * `userData` points to a fresh temporary directory on each run, so tests
 * never touch the host's actual configuration.
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

/** Temporary root for this test run, to inspect what has been written. */
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
