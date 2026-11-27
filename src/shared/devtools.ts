/**
 * Command-line switch the main process appends to the renderer's argv
 * (webPreferences.additionalArguments) when DevTools are allowed. The preload
 * reads it from process.argv: a sandboxed preload has no other synchronous way
 * to learn a main-process setting before the renderer builds its keymap.
 */
export const DEVTOOLS_ARG = '--cm-devtools'
