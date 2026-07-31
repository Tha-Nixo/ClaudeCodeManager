import type { LaunchOptions } from '@shared/types'
import { TerminalHost } from './host'

/**
 * Registro dei terminali vivi, chiave = id sessione.
 *
 * Sta fuori da React di proposito: gli host devono sopravvivere ai render e
 * ai rimontaggi dei componenti. React chiede un host tramite `hostFor` e lo
 * innesta nel proprio slot.
 */
const hosts = new Map<string, TerminalHost>()

/** Host già creati ma non ancora associati a un PTY (fase di misurazione). */
const unbound = new Set<TerminalHost>()

let wired = false

/** Collega una sola volta gli eventi main -> renderer al registro. */
export function wireTerminalEvents(): () => void {
  if (wired) return () => undefined
  wired = true

  const offData = window.cm.pty.onData(({ id, data }) => {
    hosts.get(id)?.write(data)
  })
  const offExit = window.cm.pty.onExit(({ id, exitCode }) => {
    hosts
      .get(id)
      ?.writeAppMessage(
        `— la shell del riquadro è terminata (codice ${exitCode}). Il riquadro resta aperto.`
      )
  })

  return () => {
    offData()
    offExit()
    wired = false
  }
}

export function hostFor(id: string): TerminalHost | undefined {
  return hosts.get(id)
}

/**
 * Crea un terminale, lo misura e solo dopo fa nascere il PTY con le
 * dimensioni giuste. Farlo nell'ordine inverso significherebbe far partire
 * Claude a 80x24 e poi ridisegnare tutto, con un lampeggio visibile.
 */
export async function createSession(
  slot: HTMLElement,
  opts: LaunchOptions
): Promise<{ id: string; host: TerminalHost }> {
  const host = new TerminalHost()
  unbound.add(host)

  host.attach(slot)
  const { cols, rows } = host.fitNow()

  try {
    const result = await window.cm.pty.create({ ...opts, cols, rows })
    unbound.delete(host)
    hosts.set(result.id, host)
    host.bind(result.id)
    host.focus()
    return { id: result.id, host }
  } catch (err) {
    unbound.delete(host)
    host.dispose()
    throw err
  }
}

export async function destroySession(id: string): Promise<void> {
  const host = hosts.get(id)
  hosts.delete(id)
  host?.dispose()
  await window.cm.pty.kill(id)
}

export function disposeAllHosts(): void {
  for (const host of hosts.values()) host.dispose()
  for (const host of unbound) host.dispose()
  hosts.clear()
  unbound.clear()
}
