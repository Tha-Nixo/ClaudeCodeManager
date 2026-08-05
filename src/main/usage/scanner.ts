import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { SessionUsage, UsageSummary } from '@shared/types'
import { projectsDir } from '../claude/paths'
import { readJson, writeJsonAtomic } from '../store/config'
import {
  ZERO_TOKENS,
  addTokens,
  contextWindowFor,
  costOf,
  isBillable,
  totalTokens,
  type TokenCounts
} from './pricing'

/**
 * Contabilità dei token a partire dai transcript di Claude Code.
 *
 * L'unità di incrementalità è il FILE, non la riga. Quando un transcript
 * cambia lo si rilegge per intero e se ne sostituisce il contributo.
 *
 * Sembra più costoso di riprendere dall'ultima riga letta, ma evita un errore
 * concreto: Claude Code scrive PIÙ righe con lo stesso `message.id` per la
 * stessa risposta API, e vale l'ultima. Riprendendo da metà file, una riga già
 * conteggiata che ricompare più avanti verrebbe sommata due volte. Rileggendo
 * il file intero la deduplica per message.id è sempre corretta, e in regime
 * stazionario cambia solo il transcript della sessione attiva.
 */

// Alzata a 4 per i campi dell'ultimo turno: la riscansione completa che ne
// consegue costa qualche decina di millisecondi, una volta sola.
const CACHE_VERSION = 4

interface FileContribution {
  mtimeMs: number
  size: number
  sessionId: string
  cwd: string | null
  turns: number
  firstAt: number
  lastAt: number
  /** Token per modello: il costo dipende dal modello, non si può aggregare prima. */
  byModel: Record<string, TokenCounts>
  /** Token per giorno (YYYY-MM-DD) e modello. */
  byDay: Record<string, Record<string, TokenCounts>>
  /**
   * Token in ingresso dell'ULTIMO turno assistant, cache compresa.
   *
   * Approssima quanto è pieno il contesto adesso: ogni richiesta rimanda
   * l'intera conversazione, quindi l'ingresso dell'ultimo turno è la
   * dimensione corrente della conversazione. `input_tokens` da solo non
   * basta: è la sola parte NON servita dalla cache, e in una sessione lunga
   * è la minoranza.
   */
  lastContext: number
  /** Modello dell'ultimo turno, per sapere contro quale finestra rapportarlo. */
  lastModel: string | null
}

interface UsageCache {
  version: number
  files: Record<string, FileContribution>
}

let cache: UsageCache | null = null
let lastScan = 0
const MIN_RESCAN_MS = 2_000

function cachePath(): string {
  return join(app.getPath('userData'), 'usage-cache.json')
}

function loadCache(): UsageCache {
  if (cache) return cache
  const stored = readJson<UsageCache>(cachePath())
  cache = stored && stored.version === CACHE_VERSION ? stored : { version: CACHE_VERSION, files: {} }
  return cache
}

/** Tutti i transcript, inclusi quelli dei sotto-agenti nelle sottocartelle. */
function findTranscripts(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) findTranscripts(full, out)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

interface Turn {
  model: string | null
  tokens: TokenCounts
  timestamp: number
}

function parseTranscript(file: string): Omit<FileContribution, 'mtimeMs' | 'size'> {
  const contribution: Omit<FileContribution, 'mtimeMs' | 'size'> = {
    sessionId: basename(file, '.jsonl'),
    cwd: null,
    turns: 0,
    firstAt: 0,
    lastAt: 0,
    byModel: {},
    byDay: {},
    lastContext: 0,
    lastModel: null
  }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return contribution
  }

  // Deduplica dentro il file: più record condividono lo stesso message.id e
  // solo l'ultimo porta i totali definitivi. Sommarli tutti gonfia i numeri.
  const byMessageId = new Map<string, Turn>()

  for (const line of raw.split('\n')) {
    if (!line.trim() || !line.includes('"usage"')) continue

    let rec: {
      type?: string
      cwd?: string
      timestamp?: string
      message?: {
        id?: string
        model?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          cache_creation?: {
            ephemeral_5m_input_tokens?: number
            ephemeral_1h_input_tokens?: number
          }
        }
      }
    }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }

    if (rec.type !== 'assistant') continue
    if (rec.cwd && !contribution.cwd) contribution.cwd = rec.cwd

    const usage = rec.message?.usage
    if (!usage) continue

    const created = usage.cache_creation
    const creationTotal = usage.cache_creation_input_tokens ?? 0
    // La ripartizione 5m/1h è quella autorevole quando c'è; altrimenti si
    // attribuisce tutto ai 5 minuti, che è il TTL predefinito.
    const write5m = created?.ephemeral_5m_input_tokens ?? (created ? 0 : creationTotal)
    const write1h = created?.ephemeral_1h_input_tokens ?? 0

    const tokens: TokenCounts = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h
    }

    const sum =
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
    if (sum === 0) continue

    const model = rec.message?.model ?? null
    if (!isBillable(model)) continue

    const timestamp = rec.timestamp ? Date.parse(rec.timestamp) : 0
    const key = rec.message?.id
    const turn: Turn = { model, tokens, timestamp }

    // Ordine del file, non del timestamp: l'ultimo turno scritto è quello che
    // descrive il contesto adesso, e i timestamp fra sotto-agenti e sessione
    // principale non sono necessariamente monotoni.
    contribution.lastContext = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
    contribution.lastModel = model

    // Senza message.id non c'è modo di deduplicare: si tiene comunque il
    // turno, usando una chiave unica.
    byMessageId.set(key || `anon-${byMessageId.size}`, turn)
  }

  for (const turn of byMessageId.values()) {
    const model = turn.model ?? 'sconosciuto'
    contribution.turns += 1
    contribution.byModel[model] = addTokens(contribution.byModel[model] ?? ZERO_TOKENS, turn.tokens)

    if (turn.timestamp > 0) {
      const day = localDayKey(new Date(turn.timestamp))
      contribution.byDay[day] ??= {}
      contribution.byDay[day][model] = addTokens(
        contribution.byDay[day][model] ?? ZERO_TOKENS,
        turn.tokens
      )
      contribution.firstAt =
        contribution.firstAt === 0
          ? turn.timestamp
          : Math.min(contribution.firstAt, turn.timestamp)
      contribution.lastAt = Math.max(contribution.lastAt, turn.timestamp)
    }
  }

  return contribution
}

/** Aggiorna la cache leggendo solo i transcript cambiati. */
export function scan(force = false): void {
  if (!force && Date.now() - lastScan < MIN_RESCAN_MS) return
  lastScan = Date.now()

  const state = loadCache()
  const dir = projectsDir()
  if (!existsSync(dir)) return

  const files = findTranscripts(dir)
  const present = new Set(files)
  let changed = false

  for (const file of files) {
    let stat: import('node:fs').Stats
    try {
      stat = statSync(file)
    } catch {
      continue
    }

    const known = state.files[file]
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue

    state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, ...parseTranscript(file) }
    changed = true
  }

  // Transcript cancellati: il loro contributo va tolto.
  //
  // È una differenza deliberata rispetto a claude-usage, che accumula per
  // sempre: sulla stessa macchina il suo database contiene 5 transcript non
  // più esistenti, per 412 turni e 345k token di output che continua a
  // sommare. Qui i numeri descrivono i transcript che ci sono davvero, così
  // restano verificabili e la pulizia periodica di Claude Code non li gonfia.
  for (const known of Object.keys(state.files)) {
    if (!present.has(known)) {
      delete state.files[known]
      changed = true
    }
  }

  if (changed) writeJsonAtomic(cachePath(), state)
}

/**
 * Utilizzo per singola sessione, indicizzato per sessionId.
 *
 * Serve al pannello di monitoraggio, che ragiona per riquadro e non per
 * cartella o modello come fa `summarize`. La scansione è la stessa: chiamarli
 * entrambi nello stesso giro non costa il doppio, perché `scan` ha una
 * frequenza minima propria.
 */
export function sessionUsage(): Record<string, SessionUsage> {
  scan()
  const state = loadCache()
  const out: Record<string, SessionUsage> = {}

  for (const file of Object.values(state.files)) {
    let tokens = 0
    let cost = 0
    for (const [model, counts] of Object.entries(file.byModel)) {
      tokens += totalTokens(counts)
      cost += costOf(model, counts)
    }

    const { window, approximate } = contextWindowFor(file.lastModel)

    // Un sotto-agente ha un transcript proprio ma lo stesso id non esiste
    // altrove, quindi la mappa non ha collisioni: una voce per file.
    out[file.sessionId] = {
      sessionId: file.sessionId,
      cwd: file.cwd,
      turns: file.turns,
      tokens,
      cost,
      lastAt: file.lastAt,
      contextTokens: file.lastContext,
      contextWindow: window,
      contextApproximate: approximate,
      model: file.lastModel
    }
  }

  return out
}

/**
 * Chiave del giorno secondo il fuso dell'utente, non secondo Greenwich.
 *
 * `toISOString()` dava il giorno UTC: per chi sta in Italia il lavoro fatto
 * fra mezzanotte e le due del mattino finiva contato nel giorno precedente, e
 * «Oggi» — il numero piu' in vista dell'app — diceva una cosa diversa da
 * quella che l'utente aveva appena fatto. Nei fusi negativi succedeva il
 * contrario. La chiave resta nella stessa forma AAAA-MM-GG, quindi i confronti
 * e l'ordinamento non cambiano.
 */
function localDayKey(d: Date): string {
  const mese = String(d.getMonth() + 1).padStart(2, '0')
  const giorno = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mese}-${giorno}`
}

function dayKey(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return localDayKey(d)
}

export function summarize(): UsageSummary {
  scan()
  const state = loadCache()

  const today = dayKey(0)
  const last7 = new Set(Array.from({ length: 7 }, (_, i) => dayKey(i)))

  let todayCost = 0
  let weekCost = 0
  let totalCost = 0
  let todayTokens = 0
  let weekTokens = 0
  let totalTokensAll = 0
  let sessions = 0

  const byModel: Record<string, { tokens: number; cost: number }> = {}
  const byProject: Record<string, { tokens: number; cost: number }> = {}

  for (const contribution of Object.values(state.files)) {
    if (contribution.turns === 0) continue
    sessions += 1

    const project = contribution.cwd ?? 'sconosciuto'

    for (const [model, tokens] of Object.entries(contribution.byModel)) {
      const cost = costOf(model, tokens)
      const count =
        tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h

      totalCost += cost
      totalTokensAll += count

      byModel[model] ??= { tokens: 0, cost: 0 }
      byModel[model].tokens += count
      byModel[model].cost += cost

      byProject[project] ??= { tokens: 0, cost: 0 }
      byProject[project].tokens += count
      byProject[project].cost += cost
    }

    for (const [day, models] of Object.entries(contribution.byDay)) {
      for (const [model, tokens] of Object.entries(models)) {
        const cost = costOf(model, tokens)
        const count =
          tokens.input +
          tokens.output +
          tokens.cacheRead +
          tokens.cacheWrite5m +
          tokens.cacheWrite1h
        if (day === today) {
          todayCost += cost
          todayTokens += count
        }
        if (last7.has(day)) {
          weekCost += cost
          weekTokens += count
        }
      }
    }
  }

  return {
    todayCost,
    todayTokens,
    weekCost,
    weekTokens,
    totalCost,
    totalTokens: totalTokensAll,
    sessions,
    byModel: Object.entries(byModel)
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost),
    byProject: Object.entries(byProject)
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 12),
    generatedAt: Date.now()
  }
}
