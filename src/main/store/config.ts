import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/types'

/**
 * Radici predefinite per l'indice: le cartelle dove di solito si tengono i
 * progetti. Sta qui e non nell'indicizzatore per non creare un ciclo di
 * import, dato che l'indicizzatore usa le funzioni di scrittura di questo file.
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
 * Scrittura atomica: si scrive su un file temporaneo e si rinomina.
 * Un crash a metà scrittura lascia il file precedente intatto invece di
 * un JSON troncato che all'avvio successivo farebbe perdere la configurazione.
 */
export function writeJsonAtomic(target: string, value: unknown): boolean {
  const tmp = `${target}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, target)
    return true
  } catch (err) {
    // Disco pieno, permessi, file in uso: perdere una scrittura è accettabile,
    // far morire il processo principale con dentro tutti i PTY no. Alcune di
    // queste chiamate avvengono dentro un timer, dove un'eccezione non
    // catturata abbatterebbe l'app.
    console.error(`scrittura di ${target} fallita`, err)
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Nulla da fare: il file temporaneo resta e verrà sovrascritto.
    }
    return false
  }
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
    initialRows: stored?.initialRows ?? DEFAULT_CONFIG.initialRows,
    restoreResumesSessions: stored?.restoreResumesSessions ?? DEFAULT_CONFIG.restoreResumesSessions,
    indexSources: { ...DEFAULT_CONFIG.indexSources, ...stored?.indexSources },
    // Senza radici configurate si usano quelle in cui si tengono di solito i
    // progetti, così l'indice è utile al primo avvio senza chiedere nulla.
    scanRoots: stored?.scanRoots?.length ? stored.scanRoots : defaultRoots(),
    themeId: stored?.themeId ?? DEFAULT_CONFIG.themeId
  }
  return cached
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  cached = { ...getConfig(), ...patch }
  writeJsonAtomic(pathToConfig(), cached)
  return cached
}
