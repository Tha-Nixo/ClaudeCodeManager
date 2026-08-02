import { BrowserWindow, type WebContents } from 'electron'
import type { MonitorPane, MonitorState } from '@shared/types'
import { sessionUsage, summarize } from '../usage/scanner'

/**
 * Stato del pannello di monitoraggio.
 *
 * Il pannello vive in due contenitori — il cassetto dentro la finestra
 * principale e la finestra staccata — e i due non condividono memoria. Lo
 * stato sta quindi nel main, che è l'unico punto che entrambi vedono.
 *
 * Il main però non sa nulla dei riquadri: quelli sono stato React del
 * renderer principale, che li pubblica qui ad ogni cambiamento. È l'unica
 * direzione sensata — spostare l'albero del compositor nel main per far
 * leggere due numeri a una finestrella sarebbe un rifacimento sproporzionato.
 */

/** Cadenza dell'aggiornamento mentre qualcuno guarda. */
const TICK_MS = 2_000

/** Ultimo elenco pubblicato dal renderer principale. */
let panes: MonitorPane[] = []

/**
 * Chi sta guardando, per identità e non per conteggio.
 *
 * Un contatore si sbilancia al primo caso storto — una finestra chiusa senza
 * disiscriversi, un renderer che si ricarica, un crash — e resta acceso un
 * timer che rilegge i transcript ogni due secondi per nessuno, senza che
 * niente lo segnali. Tenendo i webContents si può verificare che siano ancora
 * vivi, e la contabilità si autocorregge.
 */
const watchers = new Set<WebContents>()
let timer: NodeJS.Timeout | null = null

/** Manda un evento a ogni finestra, non solo alla principale. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Compone lo stato completo unendo i riquadri ai numeri dei transcript.
 *
 * La scansione è incrementale e ha una frequenza minima propria, quindi
 * chiamarla ogni due secondi costa quasi nulla quando niente è cambiato.
 */
export function currentState(): MonitorState {
  const usage = sessionUsage()
  const today = summarize()

  return {
    panes: panes.map((pane) => ({
      ...pane,
      usage: pane.claudeSessionId ? usage[pane.claudeSessionId] : undefined
    })),
    todayCost: today.todayCost,
    todayTokens: today.todayTokens,
    updatedAt: Date.now()
  }
}

/** Ferma il timer quando non guarda più nessuno; lo avvia quando serve. */
function syncTimer(): void {
  for (const wc of watchers) if (wc.isDestroyed()) watchers.delete(wc)

  if (watchers.size > 0 && !timer) {
    timer = setInterval(() => {
      // Un renderer può sparire fra un giro e l'altro senza dire niente.
      for (const wc of watchers) if (wc.isDestroyed()) watchers.delete(wc)
      if (watchers.size === 0) return syncTimer()
      broadcast('monitor:state', currentState())
    }, TICK_MS)
  } else if (watchers.size === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Il renderer principale pubblica i suoi riquadri. */
export function publishPanes(next: MonitorPane[]): void {
  panes = Array.isArray(next) ? next : []
  // Il cambiamento è immediato e visibile: non si aspetta il prossimo giro.
  if (watchers.size > 0) broadcast('monitor:state', currentState())
}

export function subscribe(sender: WebContents): MonitorState {
  watchers.add(sender)
  // Una ricarica del renderer non passa da unsubscribe: si toglie qui.
  sender.once('destroyed', () => {
    watchers.delete(sender)
    syncTimer()
  })
  syncTimer()
  return currentState()
}

export function unsubscribe(sender: WebContents): void {
  watchers.delete(sender)
  syncTimer()
}
