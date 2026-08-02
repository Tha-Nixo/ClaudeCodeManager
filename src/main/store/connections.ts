import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import type { SshConnection } from '@shared/types'
import { readJson, writeJsonAtomic } from './config'

/**
 * Connessioni ssh salvate.
 *
 * Qui non finisce mai una password: l'autenticazione è delegata interamente a
 * ssh, che usa le chiavi e l'agent già configurati sul sistema. Al massimo si
 * memorizza il PERCORSO di una chiave, mai il suo contenuto.
 */

interface ConnectionsState {
  connections: SshConnection[]
}

let cached: ConnectionsState | null = null

function file(): string {
  return join(app.getPath('userData'), 'connections.json')
}

/** Scarta i record incompleti: un host vuoto produrrebbe un comando ssh senza senso. */
function sanitize(raw: unknown): SshConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Partial<SshConnection>
  if (typeof c.host !== 'string' || !c.host.trim()) return null
  if (typeof c.user !== 'string') return null

  const port = typeof c.port === 'number' && c.port > 0 && c.port < 65536 ? c.port : undefined
  return {
    id: typeof c.id === 'string' && c.id ? c.id : randomUUID(),
    name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : c.host.trim(),
    host: c.host.trim(),
    user: c.user.trim(),
    port,
    identityFile: typeof c.identityFile === 'string' && c.identityFile.trim()
      ? c.identityFile.trim()
      : undefined,
    remotePath: typeof c.remotePath === 'string' && c.remotePath.trim() ? c.remotePath.trim() : '~',
    lastUsed: typeof c.lastUsed === 'number' ? c.lastUsed : 0
  }
}

function load(): ConnectionsState {
  if (cached) return cached
  const stored = readJson<Partial<ConnectionsState>>(file())
  const list = Array.isArray(stored?.connections) ? stored.connections : []
  cached = { connections: list.map(sanitize).filter((c): c is SshConnection => c !== null) }
  return cached
}

function persist(): void {
  if (cached) writeJsonAtomic(file(), cached)
}

/** Connessioni ordinate per utilizzo recente, poi per nome. */
export function listConnections(): SshConnection[] {
  return [...load().connections].sort(
    (a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name)
  )
}

export function getConnection(id: string): SshConnection | null {
  return load().connections.find((c) => c.id === id) ?? null
}

/** Crea o aggiorna una connessione; ritorna la versione normalizzata. */
export function saveConnection(input: Partial<SshConnection>): SshConnection | null {
  const state = load()
  const existing = input.id ? state.connections.find((c) => c.id === input.id) : undefined
  const merged = sanitize({ ...existing, ...input, id: existing?.id ?? input.id ?? randomUUID() })
  if (!merged) return null

  state.connections = existing
    ? state.connections.map((c) => (c.id === merged.id ? merged : c))
    : [...state.connections, merged]
  persist()
  return merged
}

export function deleteConnection(id: string): void {
  const state = load()
  state.connections = state.connections.filter((c) => c.id !== id)
  persist()
}

/** Segna l'uso e memorizza l'ultima cartella remota aperta, che è quasi sempre la prossima. */
export function touchConnection(id: string, remotePath?: string): void {
  const state = load()
  const found = state.connections.find((c) => c.id === id)
  if (!found) return
  found.lastUsed = Date.now()
  if (remotePath?.trim()) found.remotePath = remotePath.trim()
  persist()
}
