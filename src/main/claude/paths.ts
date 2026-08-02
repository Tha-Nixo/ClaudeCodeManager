import { openSync, readSync, closeSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Corrispondenza fra cartella di lavoro e directory dei transcript.
 *
 * Claude Code sostituisce con '-' OGNI carattere non alfanumerico:
 *   C:\Users\Tha_Nixo\Desktop\ClaudeManager
 *   -> C--Users-Tha-Nixo-Desktop-ClaudeManager
 *
 * La trasformazione e' LOSSY: '_', ' ', '.' e '-' collassano tutti su '-'.
 * Si codifica quindi solo in avanti, mai al contrario: per risalire al
 * percorso reale si legge il campo `cwd` dentro un transcript, oppure il campo
 * `project` di history.jsonl, che contiene gia' il percorso non codificato.
 */
export function encodeProjectDir(fullPath: string): string {
  // I separatori vanno normalizzati PRIMA di codificare: 'C:\foo\' e 'C:\foo'
  // sono la stessa cartella, ma darebbero 'C--foo-' e 'C--foo', e solo il
  // secondo corrisponde a quello che scrive Claude Code. La radice di
  // un'unità ('C:\') fa eccezione, perché lì il separatore è significativo.
  const normalized = fullPath.replace(/[\\/]+/g, '\\').replace(/(?<!:)\\+$/, '')
  return normalized.replace(/[^a-zA-Z0-9]/g, '-')
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function projectsDir(): string {
  return join(claudeHome(), 'projects')
}

export function transcriptsFor(fullPath: string): string[] {
  const dir = join(projectsDir(), encodeProjectDir(fullPath))
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** Percorsi normalizzati per il confronto: Windows e' case-insensitive e i
 *  separatori compaiono misti anche dentro lo stesso file di configurazione. */
export function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/

/**
 * Estrae la cwd reale da un transcript leggendone solo la testa: i record di
 * intestazione non hanno il campo, quindi si scandisce un blocco iniziale
 * invece di caricare file che possono pesare megabyte.
 */
export function readCwdFromTranscript(file: string, bytes = 64 * 1024): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    const match = CWD_RE.exec(buf.subarray(0, read).toString('utf8'))
    if (!match) return null
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface KnownFolder {
  path: string
  /** Ultima volta che la cartella e' stata usata, epoch ms. */
  lastUsed: number
  /** Numero di prompt registrati in history.jsonl per questa cartella. */
  uses: number
}

/**
 * Cartelle in cui Claude Code e' gia' stato usato.
 *
 * La sorgente principale e' history.jsonl, che elenca i percorsi REALI ed e'
 * un solo file da leggere. Le directory in projects/ servono a coprire i casi
 * che la history non contiene; per quelle si risale alla cwd leggendo la testa
 * di un transcript, mai decodificando il nome della cartella.
 */
export function knownFolders(): KnownFolder[] {
  const byPath = new Map<string, KnownFolder>()

  const add = (path: string, timestamp: number, counts: boolean): void => {
    const key = normalizePath(path)
    const existing = byPath.get(key)
    if (existing) {
      existing.lastUsed = Math.max(existing.lastUsed, timestamp)
      if (counts) existing.uses += 1
    } else {
      byPath.set(key, { path, lastUsed: timestamp, uses: counts ? 1 : 0 })
    }
  }

  // 1. history.jsonl -> percorsi reali, con frequenza e recenza.
  const history = join(claudeHome(), 'history.jsonl')
  if (existsSync(history)) {
    try {
      for (const line of readFileSync(history, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line) as { project?: string; timestamp?: number }
          if (rec.project) add(rec.project, rec.timestamp ?? 0, true)
        } catch {
          // Riga corrotta: si ignora e si prosegue.
        }
      }
    } catch {
      // History illeggibile: restano le directory dei progetti.
    }
  }

  // 2. projects/ -> cartelle mai finite nella history.
  const dir = projectsDir()
  if (existsSync(dir)) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      entries = []
    }

    for (const entry of entries) {
      // Le sessioni remote usano 'ssh-<uuid>' e non uno schema di percorso:
      // non sono cartelle locali e non vanno nell'indice.
      if (entry.startsWith('ssh-')) continue

      const projectPath = join(dir, entry)
      let files: string[]
      try {
        files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      if (files.length === 0) continue

      const cwd = readCwdFromTranscript(join(projectPath, files[0]))
      if (!cwd) continue
      if (!byPath.has(normalizePath(cwd))) add(cwd, 0, false)
    }
  }

  return [...byPath.values()].sort((a, b) => b.lastUsed - a.lastUsed)
}

// --- Fiducia sulle cartelle -------------------------------------------------

let trustCache: { at: number; map: Map<string, boolean> } | null = null
const TRUST_TTL_MS = 30_000

/**
 * Cartelle per cui il dialogo di fiducia e' gia' stato accettato.
 *
 * ~/.claude.json contiene anche `oauthAccount` e, dentro projects[].mcpServers,
 * variabili d'ambiente con chiavi API: si estrae SOLO hasTrustDialogAccepted e
 * il resto viene scartato subito, senza mai registrarlo o esporlo.
 */
export function trustedFolders(): Map<string, boolean> {
  if (trustCache && Date.now() - trustCache.at < TRUST_TTL_MS) return trustCache.map

  const map = new Map<string, boolean>()
  const file = join(homedir(), '.claude.json')

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
      }
      for (const [path, entry] of Object.entries(parsed.projects ?? {})) {
        map.set(normalizePath(path), entry?.hasTrustDialogAccepted === true)
      }
    } catch {
      // File assente o illeggibile: nessun badge di fiducia, nient'altro.
    }
  }

  trustCache = { at: Date.now(), map }
  return map
}
