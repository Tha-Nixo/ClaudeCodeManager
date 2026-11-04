import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import type { SshConnection } from '@shared/types'
import { readJson, writeJsonAtomic } from './config'

/**
 * Saved ssh connections.
 *
 * Passwords never end up here: authentication is delegated entirely to
 * ssh, using the keys and agent already configured on the system. At most,
 * we store the PATH to a key file, never its contents.
 */

interface ConnectionsState {
  connections: SshConnection[]
}

let cached: ConnectionsState | null = null

function file(): string {
  return join(app.getPath('userData'), 'connections.json')
}

/** Discards incomplete records: an empty host would yield a meaningless ssh command. */
function sanitize(raw: unknown): SshConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Partial<SshConnection>
  if (typeof c.host !== 'string' || !c.host.trim()) return null
  if (typeof c.user !== 'string') return null

  // Must be an integer: 22.7 passed previous validation and was saved,
  // causing ssh to reject sessions with "Bad port '22.7'" on every attempt,
  // leaving the invalid port persisted.
  const port =
    typeof c.port === 'number' && Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535
      ? c.port
      : undefined
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

/** Connections sorted by recent usage, then by name. */
export function listConnections(): SshConnection[] {
  return [...load().connections].sort(
    (a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name)
  )
}

export function getConnection(id: string): SshConnection | null {
  return load().connections.find((c) => c.id === id) ?? null
}

/** Creates or updates a connection; returns the normalized version. */
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

/** Marks usage and stores the last remote directory opened, which is almost always the next one. */
export function touchConnection(id: string, remotePath?: string): void {
  const state = load()
  const found = state.connections.find((c) => c.id === id)
  if (!found) return
  found.lastUsed = Date.now()
  if (remotePath?.trim()) found.remotePath = remotePath.trim()
  persist()
}
