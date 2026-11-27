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
  /**
   * Without this safety net, a regex that stops matching (a comma in the style,
   * a renamed `ipcMain`, a moved file) would make every following check pass
   * on nothing, and the suite would stay green while checking nothing at all.
   */
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
    // The two registrations would coexist without errors, but the channel would
    // answer one way or the other depending on the caller: behavior nobody can
    // work out by reading the preload.
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
      // `invoke` on a channel registered with `on` does not end in a visible error:
      // the promise never resolves, and the part of the interface waiting for it
      // keeps loading forever.
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
      // `send` to an `ipcMain.handle` reaches nobody and raises nothing: the user's
      // command vanishes without a trace.
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

/**
 * Members of the preload API, as `group.member`, read from the object literal
 * in src/preload/index.ts: groups sit at two spaces of indentation, members at four.
 */
function preloadMembers(source: string): string[] {
  const members: string[] = []
  let group: string | null = null
  for (const line of source.split('\n')) {
    const opened = /^  (\w+): \{$/.exec(line)
    if (opened) {
      group = opened[1]
      continue
    }
    if (/^  \}/.test(line)) {
      group = null
      continue
    }
    const member = /^    (\w+):/.exec(line)
    if (group && member) members.push(`${group}.${member[1]}`)
  }
  return members
}

/** Every .ts/.tsx file under src/renderer, comments stripped. */
function rendererSources(dir = join(ROOT, 'src', 'renderer')): string {
  let text = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) text += rendererSources(full)
    else if (/\.tsx?$/.test(entry.name)) text += `${readClean(full)}\n`
  }
  return text
}

const API = preloadMembers(PRELOAD)
const RENDERER = rendererSources()

const ORPHANS = sorted([...HANDLE, ...ON]).filter((c) => !INVOKE.has(c) && !SEND.has(c))

/**
 * Issue #23: three preload APIs (pty.scrollback, folders.info, folders.drives)
 * were exposed and handled in main, but nothing in the renderer called them.
 * Each one is attack surface on the renderer boundary and code to maintain, so
 * an API the renderer does not use is removed, not kept "just in case".
 */
describe('IPC Contract: nothing exposed that nobody uses (issue #23 regression)', () => {
  it('reads the preload API', () => {
    assert.ok(API.length > 20, `only found ${API.length} preload members`)
    assert.ok(API.includes('pty.create'), 'pty.create not found: has the preload layout changed?')
  })

  it('every preload API is used by the renderer', () => {
    // `window.cm.ssh\n  .sessionsFor(...)`: a call may break across lines.
    const unused = API.filter((member) => {
      const [group, name] = member.split('.')
      return !new RegExp(`\\bcm\\s*\\.\\s*${group}\\s*\\.\\s*${name}\\b`).test(RENDERER)
    })
    assert.deepEqual(unused, [], `exposed by preload but never used by the renderer: ${unused.join(', ')}`)
  })

  it('every main channel is used by preload', () => {
    assert.deepEqual(ORPHANS, [], `handled in main but never used by preload: ${ORPHANS.join(', ')}`)
  })
})
