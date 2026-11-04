import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/types'

/**
 * Default roots for indexing: directories where projects typically reside.
 * Located here rather than in the indexer to avoid circular imports,
 * as the indexer relies on writing functions in this module.
 */
export function defaultRoots(): string[] {
  const home = homedir()
  return [
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'source'),
    join(home, 'dev'),
    join(home, 'projects')
  ].filter((p) => existsSync(p))
}

/**
 * Atomic write: write to a temporary file and rename.
 * A crash mid-write leaves the previous file intact rather than
 * truncated JSON that would corrupt configuration on next launch.
 */
export function writeJsonAtomic(target: string, value: unknown): boolean {
  const tmp = `${target}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, target)
    return true
  } catch (err) {
    // Full disk, permissions, file in use: losing a write is acceptable,
    // crashing the main process with all active PTYs is not. Some of
    // these calls happen within timers where an unhandled exception would crash the app.
    console.error(`Failed to write ${target}`, err)
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Nothing to do: temporary file remains and will be overwritten.
    }
    return false
  }
}

export function readJson<T>(target: string): T | null {
  try {
    // Strip BOM before parsing: JSON.parse throws on it, causing the error
    // to be swallowed here and the file silently ignored, then overwritten
    // on next save. These files are explicitly user-editable, and on Windows
    // common tools (Set-Content -Encoding utf8, Notepad) often prepend a BOM.
    // Without this line, an innocent edit wipes out settings, bookmarks,
    // recent folders, and ssh connections.
    const raw = readFileSync(target, 'utf8')
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T
  } catch {
    return null
  }
}

let configPath: string | null = null
let cached: AppConfig | null = null

function pathToConfig(): string {
  if (!configPath) configPath = join(app.getPath('userData'), 'config.json')
  return configPath
}

export function getConfig(): AppConfig {
  if (cached) return cached

  const stored = readJson<Partial<AppConfig>>(pathToConfig())

  // The file is explicitly user-editable, so every field must be validated
  // for correct type. Previously only `keymap` was validated, and a simple
  // mistake like `scanRoots` written as a string instead of an array arrived
  // in the renderer, causing SettingsPanel to call .join() on a string and crash.
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() ? v : fallback
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

  /**
   * Merges a stored object over defaults, keeping only recognized keys
   * and only if the value matches the type of the default.
   *
   * Blind merging allowed `indexSources: { claude: 'yes' }` and
   * `launchDefaults: { model: 42 }`: the object reached the renderer with
   * invalid shape, precisely what validation is intended to prevent.
   * Extra keys are discarded: they do not belong to AppConfig and are unused.
   */
  const obj = <T extends Record<string, unknown>>(v: unknown, fallback: T): T => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fallback
    const out = { ...fallback }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!(k in fallback)) continue
      if (typeof val === typeof fallback[k]) out[k as keyof T] = val as T[keyof T]
    }
    return out
  }

  /** Retains only key-value pairs where both key and value are strings. */
  const stringMap = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val
    }
    return out
  }

  const roots =
    Array.isArray(stored?.scanRoots) && stored.scanRoots.every((r) => typeof r === 'string')
      ? stored.scanRoots
      : []

  cached = {
    defaultCwd: str(stored?.defaultCwd, homedir()),
    launchDefaults: obj(stored?.launchDefaults, DEFAULT_CONFIG.launchDefaults),
    initialCols: num(stored?.initialCols, DEFAULT_CONFIG.initialCols),
    initialRows: num(stored?.initialRows, DEFAULT_CONFIG.initialRows),
    restoreResumesSessions: bool(
      stored?.restoreResumesSessions,
      DEFAULT_CONFIG.restoreResumesSessions
    ),
    indexSources: obj(stored?.indexSources, DEFAULT_CONFIG.indexSources),
    // Without configured roots, fall back to standard project locations
    // so the index is immediately useful on first launch without prompts.
    scanRoots: roots.length ? roots : defaultRoots(),
    themeId: str(stored?.themeId, DEFAULT_CONFIG.themeId),
    notifyOnWaiting: bool(stored?.notifyOnWaiting, DEFAULT_CONFIG.notifyOnWaiting),
    // Keymap is an open map rather than a fixed-shape object: keys are
    // arbitrary user-defined shortcut sequences, so here we only verify
    // it is a Record<string, string>. The rest is validated by `resolveKeymap`.
    keymap: stringMap(stored?.keymap)
  }
  return cached
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  cached = { ...getConfig(), ...patch }
  writeJsonAtomic(pathToConfig(), cached)
  return cached
}
