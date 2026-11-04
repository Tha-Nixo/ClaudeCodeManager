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
 * Initial disk state of configuration files.
 *
 * config, folders, and connections cache file contents on FIRST access.
 * Writing files at module level sets initial state before any test runs.
 */

const BOM = '\uFEFF'

// File with wrong types for every field
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

// Valid JSON with leading BOM and corrupted `recents`
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
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cm-${prefix}-`))
}

// --- config: file read & write ----------------------------------------------

describe('readJson: handling manually edited files', () => {
  it('returns null on missing, empty, or malformed file without throwing', () => {
    const dir = tempDir('read')

    assert.equal(readJson(join(dir, 'never-existed.json')), null)

    const empty = join(dir, 'empty.json')
    writeFileSync(empty, '', 'utf8')
    assert.equal(readJson(empty), null)

    const truncated = join(dir, 'truncated.json')
    writeFileSync(truncated, '{"scanRoots": ["C:\\\\one"', 'utf8')
    assert.equal(readJson(truncated), null)

    const onlyBom = join(dir, 'only-bom.json')
    writeFileSync(onlyBom, BOM, 'utf8')
    assert.equal(readJson(onlyBom), null)
  })

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
    const file = join(dir, 'sub', 'folder', 'data.json')
    const val = { a: 1, b: ['two', 'three'], c: { d: true } }

    assert.equal(writeJsonAtomic(file, val), true)
    assert.deepEqual(readJson(file), val)
    assert.equal(existsSync(`${file}.tmp`), false)
  })

  it('returns false without throwing when path is impossible', () => {
    const dir = tempDir('impossible')
    const obstacle = join(dir, 'i-am-a-file')
    writeFileSync(obstacle, 'x', 'utf8')

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

    assert.deepEqual(readJson(file), { good: true })
  })
})

// --- config -----------------------------------------------------------------

describe('config: every field with invalid type reverts to default (issue #5 regression)', () => {
  it('cleans corrupted manual file while conforming to AppConfig', () => {
    const config = getConfig()

    assert.equal(typeof config.defaultCwd, 'string')
    assert.ok(config.defaultCwd.length > 0, 'empty defaultCwd')

    assert.equal(config.initialCols, DEFAULT_CONFIG.initialCols)
    assert.equal(config.initialRows, DEFAULT_CONFIG.initialRows)

    assert.equal(config.restoreResumesSessions, DEFAULT_CONFIG.restoreResumesSessions)
    assert.equal(typeof config.restoreResumesSessions, 'boolean')
    assert.equal(config.notifyOnWaiting, DEFAULT_CONFIG.notifyOnWaiting)
    assert.equal(typeof config.notifyOnWaiting, 'boolean')

    assert.equal(config.themeId, DEFAULT_CONFIG.themeId)
    assert.equal(typeof config.themeId, 'string')

    assert.ok(Array.isArray(config.scanRoots), 'scanRoots is not an array')
    assert.ok(
      config.scanRoots.every((r) => typeof r === 'string'),
      'scanRoots contains non-string entries'
    )
    assert.ok(!config.scanRoots.includes('C'), 'string was treated as char array')

    assert.equal(typeof config.keymap, 'object')
    assert.ok(config.keymap !== null && !Array.isArray(config.keymap))
    assert.deepEqual(config.keymap, {})

    assert.deepEqual(config.launchDefaults, DEFAULT_CONFIG.launchDefaults)
    assert.deepEqual(config.indexSources, DEFAULT_CONFIG.indexSources)
  })

  it('setConfig applies update and persists sanitized config to disk', () => {
    const newDir = tempDir('cwd')
    const after = setConfig({ defaultCwd: newDir })
    assert.equal(after.defaultCwd, newDir)

    const onDisk = JSON.parse(readFileSync(join(__userData, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >
    assert.equal(onDisk.defaultCwd, newDir, 'change was not saved to disk')
    assert.ok(Array.isArray(onDisk.scanRoots))
    assert.equal(typeof onDisk.themeId, 'string')
    assert.equal(typeof onDisk.initialCols, 'number')
  })
})

describe('config: object fields with invalid value types', () => {
  it('validates types inside launchDefaults and indexSources', () => {
    const config = getConfig()
    assert.equal(typeof config.indexSources.claude, 'boolean')
    assert.equal(typeof config.launchDefaults.model, 'string')
  })
})

// --- folders ----------------------------------------------------------------

describe('folders: folder selector robustness', () => {
  it('returns valid arrays despite corrupted file (issues #9 & #4)', () => {
    const recents = getRecents()
    assert.ok(Array.isArray(recents), 'getRecents did not return array')
    assert.ok(
      recents.every((r) => Boolean(r) && typeof r.path === 'string'),
      'recents contains non-folder elements'
    )
    assert.ok(!recents.some((r) => r.path === 'C'))

    const favorites = getFavorites()
    assert.ok(Array.isArray(favorites), 'getFavorites did not return array')
    assert.ok(favorites.includes('C:\\favorite\\one'), 'favorite missing: BOM not skipped?')
    assert.ok(favorites.includes('C:\\favorite\\two'))
    assert.ok(
      favorites.every((f) => typeof f === 'string'),
      'favorites contains non-string elements'
    )
  })

  it('records opened folder without duplicates and persists to disk', () => {
    const folder = tempDir('recent')

    touchRecent(folder)
    assert.equal(getRecents()[0].path, folder, 'recently opened folder not at top')

    touchRecent(`${folder}\\`)
    const matches = getRecents().filter((r) => r.path.toLowerCase().startsWith(folder.toLowerCase()))
    assert.equal(matches.length, 1, 'same folder appears multiple times in recents')

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

    assert.equal(
      list.some((c) => c.id === 'file-missing-host'),
      false,
      'connection without host was retained'
    )

    assert.ok(list.every((c) => typeof c.host === 'string' && c.host.length > 0))
    assert.ok(list.every((c) => typeof c.name === 'string' && c.name.length > 0))
  })

  it('getConnection returns null for non-existent id', () => {
    assert.equal(getConnection('non-existent-id'), null)
  })

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
      assert.equal(getConnection(saved.id)?.port, expected)
      deleteConnection(saved.id)
      assert.equal(getConnection(saved.id), null, 'deleted connection remained')
    }
  })

  it('never writes extraneous password fields to disk', () => {
    const SECRET = 's3cr3t-th4t-must-n0t-reach-disk'
    const withPassword = { host: 'secrets.example', user: 'nico', password: SECRET }

    const created = saveConnection(withPassword as Partial<SshConnection>)
    assert.ok(created)
    assert.equal((created as Record<string, unknown>).password, undefined)

    const updated = saveConnection({
      ...withPassword,
      id: created.id,
      remotePath: '/home'
    } as Partial<SshConnection>)
    assert.ok(updated)
    assert.equal((updated as Record<string, unknown>).password, undefined)
    assert.equal(updated.remotePath, '/home')

    const onDisk = readFileSync(join(__userData, 'connections.json'), 'utf8')
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
    assert.deepEqual(layout.tree, { kind: 'leaf' })
  })

  it('returns null when no panes can be recovered', () => {
    writeRaw({ version: 1, savedAt: 1, tree: {}, panes: [null, { paneId: 'orphan' }] })
    assert.equal(loadLayout(), null)

    writeRaw({ version: 1, savedAt: 1, tree: {}, panes: [] })
    assert.equal(loadLayout(), null)
  })

  it('flushLayout writes synchronously and layout can be reloaded', () => {
    rmSync(layoutFile(), { force: true })

    saveLayout({ version: 0, savedAt: 0, tree: { kind: 'leaf' }, panes: [validPane] })
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
