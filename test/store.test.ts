import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { __userData } from './helpers/electron'
import { DEFAULT_CONFIG, type SshConnection } from '../src/shared/types'
import { getConfig, readJson, setConfig, writeJsonAtomic } from '../src/main/store/config'
import { getFavorites, getRecents, toggleFavorite, touchRecent } from '../src/main/store/folders'
import {
  deleteConnection,
  getConnection,
  listConnections,
  saveConnection
} from '../src/main/store/connections'
import { flushLayout, loadLayout, saveLayout } from '../src/main/store/layout'

/**
 * Initial disk state of the three files.
 *
 * config, folders and connections cache the file contents on FIRST access and
 * never read them again: within one test file there is a single chance to
 * decide what they start from. The files are therefore written here, at module
 * level, before any test calls a function, and every case about loading sits
 * in a single `it` per group. The other assertions are relative (they look up
 * their own id or path), so the execution order cannot affect them.
 */

/** The character Notepad and `Set-Content -Encoding utf8` put at the start of a file. */
const BOM = '\uFEFF'

// Every field has the wrong type: this is the file that broke Settings.
writeFileSync(
  join(__userData, 'config.json'),
  JSON.stringify({
    defaultCwd: 42,
    launchDefaults: 'opus',
    initialCols: '200',
    initialRows: 0,
    restoreResumesSessions: 'true',
    indexSources: ['claude'],
    scanRoots: 'C:\\one;C:\\two',
    themeId: 7,
    notifyOnWaiting: 'no',
    keymap: ['ctrl+alt+t']
  }),
  'utf8'
)

// Valid JSON preceded by a BOM, with a corrupted `recents`: the favorites are
// read only if the BOM is skipped, the recents only if the type is validated.
writeFileSync(
  join(__userData, 'folders.json'),
  BOM +
    JSON.stringify({
      recents: 'C:\\projects',
      favorites: ['C:\\favorite\\one', 42, 'C:\\favorite\\two']
    }),
  'utf8'
)

writeFileSync(
  join(__userData, 'connections.json'),
  JSON.stringify({
    connections: [
      {
        id: 'file-good',
        name: 'Good Server',
        host: 'srv.example',
        user: 'nico',
        port: 2222,
        remotePath: '/srv'
      },
      { id: 'file-broken-port', host: 'fractional.example', user: 'nico', port: 22.7 },
      { id: 'file-missing-host', user: 'nico', port: 22 },
      'not an object',
      null
    ]
  }),
  'utf8'
)

/** Disposable directory to avoid touching real paths. */
/** Throwaway working folder, so that no test ever touches a real path. */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cm-${prefix}-`))
}

// --- config: file read & write ----------------------------------------------

describe('readJson: handling manually edited files', () => {
  it('returns null on missing, empty, or malformed file without throwing', () => {
    const dir = tempDir('read')

    // On first launch none of these files exists: if readJson threw, the app
    // would die before drawing its window.
    assert.equal(readJson(join(dir, 'never-existed.json')), null)

    const empty = join(dir, 'empty.json')
    writeFileSync(empty, '', 'utf8')
    assert.equal(readJson(empty), null)

    // A file truncated by a crash halfway through a write.
    const truncated = join(dir, 'truncated.json')
    writeFileSync(truncated, '{"scanRoots": ["C:\\\\one"', 'utf8')
    assert.equal(readJson(truncated), null)

    // Only a BOM, no content: an empty string is left after the slice.
    const onlyBom = join(dir, 'only-bom.json')
    writeFileSync(onlyBom, BOM, 'utf8')
    assert.equal(readJson(onlyBom), null)
  })

  /**
   * Regression of issue #4.
   *
   * readJson did not skip the BOM, JSON.parse threw, the error was swallowed
   * and the file counted as "missing": whoever opened config.json in Notepad to
   * change one line found settings, favorites and ssh connections back to their
   * defaults with no explanation, and overwritten at the next write.
   */
  it('reads valid JSON preceded by BOM (issue #4 regression)', () => {
    const dir = tempDir('bom')
    const file = join(dir, 'with-bom.json')
    const content = { themeId: 'night', scanRoots: ['C:\\one'], keymap: { 'ctrl+t': 'new' } }

    writeFileSync(file, BOM + JSON.stringify(content, null, 2), 'utf8')

    assert.deepEqual(readJson(file), content)
  })
})

describe('writeJsonAtomic: robust atomic writing', () => {
  it('writes atomically, creates missing dirs, and reads back identically', () => {
    const dir = tempDir('write')
    // On first launch userData exists but its subfolders do not: the write must
    // create them instead of failing.
    const file = join(dir, 'sub', 'folder', 'data.json')
    const val = { a: 1, b: ['two', 'three'], c: { d: true } }

    assert.equal(writeJsonAtomic(file, val), true)
    assert.deepEqual(readJson(file), val)
    // The temporary file must not outlive a successful write.
    assert.equal(existsSync(`${file}.tmp`), false)
  })

  it('returns false without throwing when path is impossible', () => {
    const dir = tempDir('impossible')
    const obstacle = join(dir, 'i-am-a-file')
    writeFileSync(obstacle, 'x', 'utf8')

    // A parent folder that is actually a file: mkdir fails at once. Many of
    // these writes start from a timer, where an uncaught exception would take
    // down the main process, and every PTY with it.
    const target = join(obstacle, 'sub', 'data.json')
    assert.equal(writeJsonAtomic(target, { a: 1 }), false)

    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith('.tmp')),
      [],
      'failed write left orphan .tmp file'
    )
  })

  it('cleans up .tmp when rename fails', () => {
    const dir = tempDir('rename')
    // The target exists but is a folder: the temporary file really gets written
    // and the rename fails. This is the case where the .tmp would stay on disk
    // forever, one for every attempt.
    const target = join(dir, 'blocked.json')
    mkdirSync(target)

    assert.equal(writeJsonAtomic(target, { a: 1 }), false)
    assert.equal(existsSync(`${target}.tmp`), false, 'orphan .tmp was not cleaned up')
  })

  it('preserves existing file when value cannot be serialized', () => {
    const dir = tempDir('circular')
    const file = join(dir, 'data.json')
    assert.equal(writeJsonAtomic(file, { good: true }), true)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.equal(writeJsonAtomic(file, circular), false)

    // The earlier good value must still be there: that is the whole point of
    // an atomic write.
    assert.deepEqual(readJson(file), { good: true })
  })
})

// --- config -----------------------------------------------------------------

/**
 * Regression of issue #5.
 *
 * getConfig validated only `keymap`. A trivial mistake such as `scanRoots`
 * written as a string instead of a list reached the renderer intact, where
 * the Settings panel called .join() on a string and stopped rendering: the
 * only place to fix the wrong value became unreachable because of that value.
 */
describe('config: every field with invalid type reverts to default (issue #5 regression)', () => {
  it('cleans corrupted manual file while conforming to AppConfig', () => {
    const config = getConfig()

    // A number instead of the folder: it must stay a usable path.
    assert.equal(typeof config.defaultCwd, 'string')
    assert.ok(config.defaultCwd.length > 0, 'empty defaultCwd')

    // A string instead of a number, and a number out of range (0 rows = an
    // invisible terminal): both fall back to the default.
    assert.equal(config.initialCols, DEFAULT_CONFIG.initialCols)
    assert.equal(config.initialRows, DEFAULT_CONFIG.initialRows)

    // 'true' as a string is always truthy when evaluated: the default must win
    // here, not the text.
    assert.equal(config.restoreResumesSessions, DEFAULT_CONFIG.restoreResumesSessions)
    assert.equal(typeof config.restoreResumesSessions, 'boolean')
    assert.equal(config.notifyOnWaiting, DEFAULT_CONFIG.notifyOnWaiting)
    assert.equal(typeof config.notifyOnWaiting, 'boolean')

    // A number instead of the theme id: with an id that does not exist the
    // interface would be left without colors.
    assert.equal(config.themeId, DEFAULT_CONFIG.themeId)
    assert.equal(typeof config.themeId, 'string')

    // The case that broke Settings: the string must not reach the renderer, and
    // must not become a list of characters either.
    assert.ok(Array.isArray(config.scanRoots), 'scanRoots is not an array')
    assert.ok(
      config.scanRoots.every((r) => typeof r === 'string'),
      'scanRoots contains non-string entries'
    )
    assert.ok(!config.scanRoots.includes('C'), 'string was treated as char array')

    // A list instead of the map: keymap is overlaid on the default one, and on
    // an array the overlay would produce shortcuts with numeric keys.
    assert.equal(typeof config.keymap, 'object')
    assert.ok(config.keymap !== null && !Array.isArray(config.keymap))
    assert.deepEqual(config.keymap, {})

    // A string and an array instead of the option objects.
    assert.deepEqual(config.launchDefaults, DEFAULT_CONFIG.launchDefaults)
    assert.deepEqual(config.indexSources, DEFAULT_CONFIG.indexSources)
  })

  it('setConfig applies update and persists sanitized config to disk', () => {
    // Only defaultCwd is touched, which the previous case checks without pinning
    // its value: this keeps the two cases independent of their order.
    const newDir = tempDir('cwd')
    const after = setConfig({ defaultCwd: newDir })
    assert.equal(after.defaultCwd, newDir)

    const onDisk = JSON.parse(readFileSync(join(__userData, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >
    assert.equal(onDisk.defaultCwd, newDir, 'change was not saved to disk')
    // What gets written back must not be the garbage read at startup, or the
    // file would stay broken forever.
    assert.ok(Array.isArray(onDisk.scanRoots))
    assert.equal(typeof onDisk.themeId, 'string')
    assert.equal(typeof onDisk.initialCols, 'number')
  })
})

// Object fields holding one value of the wrong type (issue #5, second half)
// need their own starting config.json: see test/config-objects.test.ts.

// --- folders ----------------------------------------------------------------

describe('folders: folder selector robustness', () => {
  /**
   * Regression of issues #9 and #4.
   *
   * With `recents` set to a string, the picker threw on every opening and the
   * only way out was deleting the file: the app's main feature became
   * unreachable with nothing to explain why. The favorites in the same file,
   * written with a BOM, prove that the rest of the content is still read
   * (issue #4): if the BOM were not skipped, two empty lists would come back
   * and the defect would go unnoticed.
   */
  it('returns valid arrays despite corrupted file (issues #9 & #4)', () => {
    const recents = getRecents()
    assert.ok(Array.isArray(recents), 'getRecents did not return array')
    assert.ok(
      recents.every((r) => Boolean(r) && typeof r.path === 'string'),
      'recents contains non-folder elements'
    )
    // The string must not have been walked character by character.
    assert.ok(!recents.some((r) => r.path === 'C'))

    const favorites = getFavorites()
    assert.ok(Array.isArray(favorites), 'getFavorites did not return array')
    // Really read from the file, BOM included.
    assert.ok(favorites.includes('C:\\favorite\\one'), 'favorite missing: BOM not skipped?')
    assert.ok(favorites.includes('C:\\favorite\\two'))
    // The 42 in the middle must not reach the renderer.
    assert.ok(
      favorites.every((f) => typeof f === 'string'),
      'favorites contains non-string elements'
    )
  })

  it('records opened folder without duplicates and persists to disk', () => {
    const folder = tempDir('recent')

    touchRecent(folder)
    assert.equal(getRecents()[0].path, folder, 'recently opened folder not at top')

    // The same folder with a trailing separator and different case: for the
    // user it is the same entry, and the list must not split in two.
    touchRecent(`${folder}\\`)
    const matches = getRecents().filter((r) => r.path.toLowerCase().startsWith(folder.toLowerCase()))
    assert.equal(matches.length, 1, 'same folder appears multiple times in recents')

    // If it does not reach the disk, the list starts empty after a restart.
    const onDisk = readFileSync(join(__userData, 'folders.json'), 'utf8')
    assert.ok(onDisk.includes(JSON.stringify(folder).slice(1, -1)))
  })

  it('toggles favorite status correctly', () => {
    const folder = tempDir('favorite')

    const afterAdd = toggleFavorite(folder)
    assert.ok(afterAdd.includes(folder))
    assert.ok(getFavorites().includes(folder))

    const afterRemove = toggleFavorite(folder)
    assert.ok(!afterRemove.includes(folder), 'favorite could not be removed')
    assert.ok(!getFavorites().includes(folder))
  })
})

// --- connections ------------------------------------------------------------

describe('connections: parsing records from manually edited file', () => {
  it('filters incomplete entries and retains valid ones without throwing', () => {
    const list = listConnections()

    const good = list.find((c) => c.id === 'file-good')
    assert.ok(good, 'valid connection was lost')
    assert.equal(good.port, 2222)
    assert.equal(good.remotePath, '/srv')

    // Without a host the ssh command makes no sense: the record is dropped.
    assert.equal(
      list.some((c) => c.id === 'file-missing-host'),
      false,
      'connection without host was retained'
    )

    // Entries that are not even objects must not bring down the loading of
    // the others.
    assert.ok(list.every((c) => typeof c.host === 'string' && c.host.length > 0))
    assert.ok(list.every((c) => typeof c.name === 'string' && c.name.length > 0))
  })

  it('getConnection returns null for non-existent id', () => {
    assert.equal(getConnection('non-existent-id'), null)
  })

  /**
   * Regression of issue #13.
   *
   * saveConnection accepted a non-integer port: 22.7 was saved, then ssh
   * rejected every attempt with "Bad port '22.7'", and the wrong port stayed
   * stored. When the port is unusable it is dropped, so ssh uses its own
   * default and the connection works.
   */
  it('accepts only integer port numbers in valid range (issue #13 regression)', () => {
    const cases: { port: unknown; expected: number | undefined }[] = [
      { port: 22, expected: 22 },
      { port: 2222, expected: 2222 },
      { port: 1, expected: 1 },
      { port: 65535, expected: 65535 },
      { port: 22.7, expected: undefined },
      { port: 0, expected: undefined },
      { port: -22, expected: undefined },
      { port: 65536, expected: undefined },
      { port: NaN, expected: undefined },
      { port: Infinity, expected: undefined },
      { port: '22', expected: undefined },
      { port: null, expected: undefined }
    ]

    for (const { port, expected } of cases) {
      const saved = saveConnection({
        host: 'port.example',
        user: 'nico',
        port: port as number
      })
      assert.ok(saved, `port ${String(port)}: connection was not saved`)
      assert.equal(
        saved.port,
        expected,
        `port ${String(port)}: expected ${String(expected)}, got ${String(saved.port)}`
      )
      // The stored port must also be the one read back.
      assert.equal(getConnection(saved.id)?.port, expected)
      deleteConnection(saved.id)
      assert.equal(getConnection(saved.id), null, 'deleted connection remained')
    }
  })

  /**
   * Authentication is delegated to ssh: no secret may end up here, not even if
   * the renderer or a future update passes one by mistake along with the other
   * fields. connections.json is a plain-text file inside userData.
   */
  it('never writes extraneous password fields to disk', () => {
    const SECRET = 's3cr3t-th4t-must-n0t-reach-disk'
    const withPassword = { host: 'secrets.example', user: 'nico', password: SECRET }

    const created = saveConnection(withPassword as Partial<SshConnection>)
    assert.ok(created)
    assert.equal((created as Record<string, unknown>).password, undefined)

    // And on an update too, where the input is merged with the existing record.
    const updated = saveConnection({
      ...withPassword,
      id: created.id,
      remotePath: '/home'
    } as Partial<SshConnection>)
    assert.ok(updated)
    assert.equal((updated as Record<string, unknown>).password, undefined)
    assert.equal(updated.remotePath, '/home')

    const onDisk = readFileSync(join(__userData, 'connections.json'), 'utf8')
    // Guard: if the record had not been written, the absence of the secret would
    // prove nothing.
    assert.ok(onDisk.includes('secrets.example'), 'record was not written to disk')
    assert.ok(!onDisk.includes(SECRET), 'password was written to connections.json')
    assert.ok(!onDisk.toLowerCase().includes('password'))

    deleteConnection(created.id)
  })
})

// --- layout -----------------------------------------------------------------

describe('layout: corrupt file does not block startup', () => {
  const layoutFile = (): string => join(__userData, 'layout.json')
  const writeRaw = (val: unknown): void =>
    writeFileSync(layoutFile(), JSON.stringify(val), 'utf8')

  const validPane = {
    paneId: 'pane-1',
    cwd: 'C:\\projects\\one',
    launch: { model: 'default', effort: 'default', permissionMode: 'default' },
    claudeSessionId: null
  }

  it('returns null when layout file does not exist', () => {
    rmSync(layoutFile(), { force: true })
    assert.equal(loadLayout(), null)
  })

  it('ignores file with unsupported version', () => {
    // A clean stage is better than panes interpreted with the wrong rules.
    writeRaw({ version: 0, savedAt: 1, tree: {}, panes: [validPane] })
    assert.equal(loadLayout(), null)

    writeRaw({ savedAt: 1, tree: {}, panes: [validPane] })
    assert.equal(loadLayout(), null)
  })

  it('ignores file where panes is not an array', () => {
    writeRaw({ version: 1, savedAt: 1, tree: {}, panes: 'pane-1' })
    assert.equal(loadLayout(), null)

    writeRaw({ version: 1, savedAt: 1, tree: {} })
    assert.equal(loadLayout(), null)
  })

  it('discards malformed panes and recovers valid ones', () => {
    writeRaw({
      version: 1,
      savedAt: 1,
      tree: { kind: 'leaf' },
      panes: [
        null,
        'pane',
        42,
        {},
        { cwd: 'C:\\projects\\two', launch: {} },
        { paneId: 'missing-launch', cwd: 'C:\\projects\\three' },
        { paneId: 'launch-not-object', cwd: 'C:\\projects\\three', launch: 'opus' },
        { paneId: 'cwd-number', cwd: 7, launch: {} },
        { paneId: 'cwd-empty', cwd: '', launch: {} },
        { paneId: '', cwd: 'C:\\projects\\four', launch: {} },
        validPane
      ]
    })

    const layout = loadLayout()
    assert.ok(layout, 'single valid pane is sufficient to recover')
    assert.equal(layout.panes.length, 1)
    assert.equal(layout.panes[0].paneId, 'pane-1')
    // The rest of the file (the tree) must survive the cleanup.
    assert.deepEqual(layout.tree, { kind: 'leaf' })
  })

  it('returns null when no panes can be recovered', () => {
    // A layout with zero panes would leave an empty window and no way to tell
    // what happened: better to start again from the picker.
    writeRaw({ version: 1, savedAt: 1, tree: {}, panes: [null, { paneId: 'orphan' }] })
    assert.equal(loadLayout(), null)

    writeRaw({ version: 1, savedAt: 1, tree: {}, panes: [] })
    assert.equal(loadLayout(), null)
  })

  it('flushLayout writes synchronously and layout can be reloaded', () => {
    rmSync(layoutFile(), { force: true })

    saveLayout({ version: 0, savedAt: 0, tree: { kind: 'leaf' }, panes: [validPane] })
    // saveLayout waits 800 ms; on quit there is no such time, and without a
    // flush the last arrangement would be lost on every exit.
    flushLayout()

    assert.ok(existsSync(layoutFile()), 'layout was not written on flush')

    const reloaded = loadLayout()
    assert.ok(reloaded)
    assert.equal(reloaded.version, 1, 'current version was not stamped')
    assert.equal(typeof reloaded.savedAt, 'number')
    assert.ok(reloaded.savedAt > 0)
    assert.equal(reloaded.panes.length, 1)
    assert.equal(reloaded.panes[0].cwd, validPane.cwd)
  })
})
