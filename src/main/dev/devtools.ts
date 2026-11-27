import { app } from 'electron'
import { DEVTOOLS_ARG } from '@shared/devtools'

/**
 * DevTools are a development tool. In a packaged build F12 used to open a
 * detached DevTools window on a stray key press (#19), so they are now off in
 * packaged builds unless the user opts in with CM_DEVTOOLS=1, for example to
 * diagnose a problem on their own machine.
 */
export function devToolsAllowed(): boolean {
  return !app.isPackaged || process.env.CM_DEVTOOLS === '1'
}

/**
 * webPreferences for every app window. `devTools: false` makes Electron ignore
 * any openDevTools() call, whatever triggers it. The extra argument tells the
 * preload, and through it the renderer, whether to bind F12 at all: when
 * DevTools are off, F12 must reach the terminal.
 */
export function devToolsPreferences(): { devTools: boolean; additionalArguments: string[] } {
  const allowed = devToolsAllowed()
  return { devTools: allowed, additionalArguments: allowed ? [DEVTOOLS_ARG] : [] }
}
