import type { ITheme } from '@xterm/xterm'
import type { CreateSessionResult, LaunchOptions } from '@shared/types'
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
/**
 * Riquadri chiusi mentre il loro PTY stava ancora nascendo. Non si può
 * ucciderli subito perché il processo non esiste ancora: si annota qui
 * l'annullamento e ci pensa `ensureSession` appena la creazione ritorna.
 */
const cancelled = new Set<string>()

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
export interface EnsureOptions {
  /**
   * Consultata quando il PTY è pronto: il fuoco va dato solo se nel frattempo
   * il riquadro è ancora quello attivo. Fra la richiesta e la risposta l'utente
   * può averne aperto o selezionato un altro.
   */
  shouldFocus?: () => boolean
}

export async function ensureSession(
  paneId: string,
  slot: HTMLElement,
  opts: LaunchOptions,
  options: EnsureOptions = {}
): Promise<CreateSessionResult | null> {
  const existing = hosts.get(paneId)
  if (existing) {
    existing.attach(slot)
    return null
  }
  if (starting.has(paneId)) return null
  starting.add(paneId)

  const host = new TerminalHost(currentTerminalTheme ?? undefined)
  host.onTitle = (title) => events?.onTitle(paneId, title)
  host.attach(slot)
  host.fitNow()

  try {
    const result = await window.cm.pty.create(opts)

    // Il riquadro può essere stato chiuso mentre il processo nasceva. Non
    // registrarlo nelle mappe non basta: il PowerShell e il claude dentro
    // esistono già e nessuno li ucciderebbe più, perché destroySession è
    // passata quando non c'era ancora nulla da uccidere.
    if (cancelled.has(paneId)) {
      host.dispose()
      await window.cm.pty.kill(result.id)
      return null
    }

    hosts.set(paneId, host)
    ptyByPane.set(paneId, result.id)
    paneByPty.set(result.id, paneId)
    host.bind(result.id)
    // Un riquadro appena creato è normalmente quello attivo, ma fra la
    // richiesta e la risposta il fuoco può essere passato altrove: rubarlo
    // manderebbe i tasti in un terminale che l'utente non sta guardando.
    if (options.shouldFocus?.() ?? true) host.focus()
    return result
  } catch (err) {
    host.dispose()
    throw err
  } finally {
    starting.delete(paneId)
    cancelled.delete(paneId)
  }
}

/** Riaggancia un terminale già vivo a un nuovo slot del DOM. */
export function attachTo(paneId: string, slot: HTMLElement): void {
  hosts.get(paneId)?.attach(slot)
}

export function focusPane(paneId: string): void {
  hosts.get(paneId)?.focus()
}

/** Cerca nello scrollback di un riquadro; falso se non trova niente. */
export function searchPane(
  paneId: string,
  query: string,
  direction: 'next' | 'previous'
): boolean {
  return hosts.get(paneId)?.search(query, direction) ?? false
}

/** Toglie le evidenziazioni: alla chiusura della barra non devono restare. */
export function clearSearch(paneId: string): void {
  hosts.get(paneId)?.clearSearch()
}

/** Rimisura il terminale: da chiamare dopo un cambio di geometria del riquadro. */
export function refit(paneId: string): void {
  hosts.get(paneId)?.fitNow()
}

/**
 * Congela la misurazione di tutti i terminali per la durata di
 * un'animazione di layout, e la riprende alla fine con una sola rimisurazione.
 */
export function setFitSuspendedAll(suspended: boolean): void {
  for (const host of hosts.values()) host.setFitSuspended(suspended)
}

/**
 * Tavolozza corrente del terminale.
 *
 * Serve conservarla qui e non solo applicarla ai terminali esistenti: un
 * riquadro aperto dopo un cambio di tema deve nascere già con i colori
 * giusti, altrimenti comparirebbe con la palette predefinita.
 */
let currentTerminalTheme: ITheme | null = null

export function applyThemeToTerminals(theme: ITheme): void {
  currentTerminalTheme = theme
  for (const host of hosts.values()) host.setTheme(theme)
}

export function terminalTheme(): ITheme | null {
  return currentTerminalTheme
}

export async function destroySession(paneId: string): Promise<void> {
  // Creazione ancora in volo: qui non c'è niente da chiudere, si annota
  // l'annullamento e ci pensa ensureSession quando il PTY sarà nato.
  if (starting.has(paneId)) {
    cancelled.add(paneId)
    return
  }

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
  cancelled.clear()
}
