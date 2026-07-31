import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/types'

/**
 * Scrittura atomica: si scrive su un file temporaneo e si rinomina.
 * Un crash a metà scrittura lascia il file precedente intatto invece di
 * un JSON troncato che all'avvio successivo farebbe perdere la configurazione.
 */
export function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, target)
}

export function readJson<T>(target: string): T | null {
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as T
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
  cached = {
    defaultCwd: stored?.defaultCwd ?? homedir(),
    launchDefaults: { ...DEFAULT_CONFIG.launchDefaults, ...stored?.launchDefaults },
    initialCols: stored?.initialCols ?? DEFAULT_CONFIG.initialCols,
    initialRows: stored?.initialRows ?? DEFAULT_CONFIG.initialRows
  }
  return cached
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  cached = { ...getConfig(), ...patch }
  writeJsonAtomic(pathToConfig(), cached)
  return cached
}
