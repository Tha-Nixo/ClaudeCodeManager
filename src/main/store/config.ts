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
    // Il BOM va tolto prima del parse: JSON.parse ci lancia sopra, l'errore
    // viene inghiottito qui e il file finisce ignorato in silenzio, poi
    // sovrascritto alla prima scrittura. Questi file sono dichiaratamente
    // modificabili a mano, e su Windows gli strumenti piu' comuni
    // (Set-Content -Encoding utf8, il Blocco note) il BOM ce lo mettono:
    // senza questa riga una modifica innocua cancella impostazioni,
    // preferiti, cartelle recenti e connessioni ssh.
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

  // Il file è dichiaratamente modificabile a mano, quindi ogni campo va
  // accettato solo se ha il tipo giusto. Prima lo era solo `keymap`, e un
  // errore banale come `scanRoots` scritto come stringa invece che come
  // elenco arrivava intatto al renderer, dove il pannello Impostazioni
  // chiamava .join() su una stringa e smetteva di disegnarsi.
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() ? v : fallback
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

  /**
   * Fonde un oggetto memorizzato sopra il predefinito, ma tiene solo le chiavi
   * gia' previste e solo se il valore ha lo stesso tipo di quello predefinito.
   *
   * Una fusione cieca lasciava passare `indexSources: { claude: 'si' }` e
   * `launchDefaults: { model: 42 }`: l'oggetto arrivava al renderer con la
   * forma sbagliata, che e' esattamente il difetto che la convalida doveva
   * chiudere. Le chiavi in piu' vengono scartate: non appartengono ad
   * AppConfig e nessuno le leggerebbe.
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

  /** Tiene solo le coppie in cui chiave e valore sono stringhe. */
  const mappaDiStringhe = (v: unknown): Record<string, string> => {
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
    // Senza radici configurate si usano quelle in cui si tengono di solito i
    // progetti, così l'indice è utile al primo avvio senza chiedere nulla.
    scanRoots: roots.length ? roots : defaultRoots(),
    themeId: str(stored?.themeId, DEFAULT_CONFIG.themeId),
    notifyOnWaiting: bool(stored?.notifyOnWaiting, DEFAULT_CONFIG.notifyOnWaiting),
    // La keymap e' una mappa aperta, non un oggetto a forma fissa: le chiavi
    // sono combinazioni che l'utente inventa, quindi qui si controlla solo che
    // sia un oggetto di stringhe. Il resto lo valida `resolveKeymap`, che sa
    // quali azioni esistono e riporta i problemi all'utente.
    keymap: mappaDiStringhe(stored?.keymap)
  }
  return cached
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  cached = { ...getConfig(), ...patch }
  writeJsonAtomic(pathToConfig(), cached)
  return cached
}
