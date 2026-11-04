import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * IPC contract between preload and main, verified on source code text.
 *
 * A channel invoked by preload but not handled by main is not a compilation
 * error: the two sides communicate via strings, and TypeScript only checks the
 * signature of `CmApi`. The issue surfaces at runtime only when the user
 * hits that feature: a menu item doing nothing, an empty panel, or an
 * `Error: No handler registered` in the console. Mismatches also fail silently:
 * `invoke` on a channel registered with `ipcMain.on` never receives a reply
 * and the promise hangs indefinitely.
 *
 * This check is structural by design: inspecting source code is instantaneous
 * and covers ALL channels, whereas testing them live would require a running
 * Electron instance and UI walkthroughs for each.
 */

/** Repository root: walks up from the bundle location without hardcoded paths. */
function repoRoot(): string {
  let dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'main', 'ipc.ts'))) return dir
    dir = join(dir, '..')
  }
  return process.cwd()
}

const ROOT = repoRoot()

/**
 * Strips comments so channel names mentioned in explanations don't count as code.
 * Removal is intentionally cautious: block comments are only stripped if opening
 * the line (in `ssh/remote.ts` there is a shell string containing `/*`), and `//`
 * is stripped outside of strings, line by line.
 */
function stripComments(source: string): string {
  const noBlocks = source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')

  return noBlocks
    .split('\n')
    .map((line) => {
      let quote: string | null = null
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (quote) {
          if (c === '\\') i++
          else if (c === quote) quote = null
          continue
        }
        if (c === "'" || c === '"' || c === '`') quote = c
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

/**
 * Extracts channel names from the first argument of a call.
 * Handles single or double quotes and spaces around parentheses.
 */
function channelsOf(source: string, callName: string): Set<string> {
  const re = new RegExp(`${callName}\\s*\\(\\s*(['"\`])([^'"\`]+)\\1`, 'g')
  const out = new Set<string>()
  for (const m of source.matchAll(re)) out.add(m[2])
  return out
}

/** Every .ts file under src/main, either in the root or a subfolder. */
function mainSources(): { file: string; text: string }[] {
  const base = join(ROOT, 'src', 'main')
  const out: { file: string; text: string }[] = []

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push({ file: `src/main/${entry.name}`, text: readClean(join(base, entry.name)) })
      continue
    }
    if (!entry.isDirectory()) continue
    for (const nested of readdirSync(join(base, entry.name), { withFileTypes: true })) {
      if (nested.isFile() && nested.name.endsWith('.ts')) {
        out.push({
          file: `src/main/${entry.name}/${nested.name}`,
          text: readClean(join(base, entry.name, nested.name))
        })
      }
    }
  }
  return out
}

function readClean(filePath: string): string {
  return stripComments(readFileSync(filePath, 'utf8'))
}

const IPC = readClean(join(ROOT, 'src', 'main', 'ipc.ts'))
const PRELOAD = readClean(join(ROOT, 'src', 'preload', 'index.ts'))
const MAIN = mainSources()

/** Registered in main. */
const HANDLE = channelsOf(IPC, 'ipcMain\\.handle')
const ON = channelsOf(IPC, 'ipcMain\\.on')

/** Used by preload. */
const INVOKE = channelsOf(PRELOAD, 'ipcRenderer\\.invoke')
const SEND = channelsOf(PRELOAD, 'ipcRenderer\\.send')
const LISTENED = channelsOf(PRELOAD, 'ipcRenderer\\.on')

/**
 * Function names that forward a channel received as parameter.
 *
 * `monitor/state.ts` does not write `webContents.send('monitor:state')`: it passes
 * the name to `broadcast`, which forwards to all windows. Searching only for
 * literal names would falsely conclude `monitor:state` is never emitted.
 */
function forwarders(source: string): string[] {
  const names = new Set<string>()
  for (const m of source.matchAll(/\.send\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    const before = source.slice(0, m.index ?? 0)
    const declarations = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
    const last = declarations[declarations.length - 1]
    if (last) names.add(last[1])
  }
  return [...names]
}

/** Events main sends to renderer, directly or via forwarding. */
const EMITTED = new Set<string>()
for (const { text } of MAIN) {
  for (const c of channelsOf(text, '\\.send')) EMITTED.add(c)
  for (const name of forwarders(text)) {
    for (const c of channelsOf(text, `\\b${name}`)) EMITTED.add(c)
  }
}

const sorted = (s: Iterable<string>): string[] => [...s].sort()

describe('IPC Contract: source extraction', () => {
  it('finds channels on both sides', () => {
    assert.ok(HANDLE.size > 0, 'no ipcMain.handle found in src/main/ipc.ts')
    assert.ok(ON.size > 0, 'no ipcMain.on found in src/main/ipc.ts')
    assert.ok(INVOKE.size > 0, 'no ipcRenderer.invoke found in preload')
    assert.ok(SEND.size > 0, 'no ipcRenderer.send found in preload')
    assert.ok(LISTENED.size > 0, 'no ipcRenderer.on found in preload')
    assert.ok(EMITTED.size > 0, 'no webContents.send found under src/main')
    assert.ok(MAIN.length > 5, `only read ${MAIN.length} sources under src/main`)
  })

  it('does not register the same channel with both handle and on', () => {
    const dupes = sorted(HANDLE).filter((c) => ON.has(c))
    assert.deepEqual(dupes, [], `channels registered twice with different handlers: ${dupes.join(', ')}`)
  })
})

describe('IPC Contract: renderer requests to main', () => {
  it('every channel called with invoke is handled with handle', () => {
    const missing: string[] = []
    const mismatched: string[] = []

    for (const channel of sorted(INVOKE)) {
      if (HANDLE.has(channel)) continue
      if (ON.has(channel)) mismatched.push(channel)
      else missing.push(channel)
    }

    assert.deepEqual(
      mismatched,
      [],
      `called with invoke but registered with ipcMain.on (promise never resolves): ${mismatched.join(', ')}`
    )
    assert.deepEqual(
      missing,
      [],
      `called from preload but unhandled in main (runtime error on first call): ${missing.join(', ')}`
    )
  })

  it('every channel sent with send is handled with on', () => {
    const missing: string[] = []
    const mismatched: string[] = []

    for (const channel of sorted(SEND)) {
      if (ON.has(channel)) continue
      if (HANDLE.has(channel)) mismatched.push(channel)
      else missing.push(channel)
    }

    assert.deepEqual(
      mismatched,
      [],
      `sent with send but registered with ipcMain.handle (message dropped): ${mismatched.join(', ')}`
    )
    assert.deepEqual(
      missing,
      [],
      `sent from preload but not listened in main: ${missing.join(', ')}`
    )
  })
})

describe('IPC Contract: events from main to renderer', () => {
  it('every event listened by preload is emitted somewhere in main', () => {
    const never = sorted(LISTENED).filter((c) => !EMITTED.has(c))
    assert.deepEqual(
      never,
      [],
      `listened by preload but never emitted in main: ${never.join(', ')}`
    )
  })
})

const ORPHANS = sorted([...HANDLE, ...ON]).filter((c) => !INVOKE.has(c) && !SEND.has(c))

describe('IPC Contract: main channels unused by preload', () => {
  it.skip(
    ORPHANS.length === 0
      ? 'no main channels left unused'
      : `handled in main but never used by preload: ${ORPHANS.join(', ')}`,
    () => {}
  )
})
