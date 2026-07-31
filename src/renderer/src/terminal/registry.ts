import type { LaunchOptions } from '@shared/types'
import { TerminalHost } from './host'

/**
 * Registro dei terminali vivi.
 *
 * L'id del RIQUADRO è generato dal renderer ed è indipendente dall'id del PTY,
 * che nasce nel main. Tenerli separati significa che il riquadro esiste (ed è
 * disegnabile, e misurabile) prima che il processo esista: il PTY può così
 * nascere già con le dimensioni giuste, e spostare un riquadro nell'albero non
 * cambia mai la sua chiave React e quindi non ne distrugge il buffer.
 */
const hosts = new Map<string, TerminalHost>()
const ptyByPane = new Map<string, string>()
const paneByPty = new Map<string, string>()
const starting = new Set<string>()

let wired = false

export interface SessionEvents {
  onExit: (paneId: string, exitCode: number) => void
  onTitle: (paneId: string, title: string) => void
}

let events: SessionEvents | null = null

export function setSessionEvents(next: SessionEvents | null): void {
  events = next
}

/** Collega una sola volta gli eventi main -> renderer al registro. */
export function wireTerminalEvents(): () => void {
  if (wired) return () => undefined
  wired = true

  const offData = window.cm.pty.onData(({ id, data }) => {
    const paneId = paneByPty.get(id)
    if (paneId) hosts.get(paneId)?.write(data)
  })

  const offExit = window.cm.pty.onExit(({ id, exitCode }) => {
    const paneId = paneByPty.get(id)
    if (!paneId) return
    hosts
      .get(paneId)
      ?.writeAppMessage(`— shell terminata (codice ${exitCode}). Il riquadro resta aperto.`)
    events?.onExit(paneId, exitCode)
  })

  return () => {
    offData()
    offExit()
    wired = false
  }
}

export function hostFor(paneId: string): TerminalHost | undefined {
  return hosts.get(paneId)
}

export function isStarted(paneId: string): boolean {
  return hosts.has(paneId) || starting.has(paneId)
}

/**
 * Crea il terminale, lo misura e solo dopo fa nascere il PTY con le dimensioni
 * giuste: all'inverso Claude partirebbe a 80x24 per poi ridisegnare tutto.
 * Idempotente, così un doppio render non spawna due processi.
 */
export async function ensureSession(
  paneId: string,
  slot: HTMLElement,
  opts: LaunchOptions
): Promise<void> {
  const existing = hosts.get(paneId)
  if (existing) {
    existing.attach(slot)
    return
  }
  if (starting.has(paneId)) return
  starting.add(paneId)

  const host = new TerminalHost()
  host.onTitle = (title) => events?.onTitle(paneId, title)
  host.attach(slot)
  host.fitNow()

  try {
    const result = await window.cm.pty.create(opts)
    hosts.set(paneId, host)
    ptyByPane.set(paneId, result.id)
    paneByPty.set(result.id, paneId)
    host.bind(result.id)
  } catch (err) {
    host.dispose()
    throw err
  } finally {
    starting.delete(paneId)
  }
}

/** Riaggancia un terminale già vivo a un nuovo slot del DOM. */
export function attachTo(paneId: string, slot: HTMLElement): void {
  hosts.get(paneId)?.attach(slot)
}

export function focusPane(paneId: string): void {
  hosts.get(paneId)?.focus()
}

/** Rimisura il terminale: da chiamare dopo un cambio di geometria del riquadro. */
export function refit(paneId: string): void {
  hosts.get(paneId)?.fitNow()
}

export async function destroySession(paneId: string): Promise<void> {
  const host = hosts.get(paneId)
  const ptyId = ptyByPane.get(paneId)

  hosts.delete(paneId)
  ptyByPane.delete(paneId)
  if (ptyId) paneByPty.delete(ptyId)

  host?.dispose()
  if (ptyId) await window.cm.pty.kill(ptyId)
}

export function disposeAllHosts(): void {
  for (const host of hosts.values()) host.dispose()
  hosts.clear()
  ptyByPane.clear()
  paneByPty.clear()
  starting.clear()
}
