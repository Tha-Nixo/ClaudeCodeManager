import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, Notification, app } from 'electron'
import type { LiveSession, MonitorPane } from '@shared/types'

/**
 * Avvisa quando una sessione passa ad attendere input.
 *
 * È il senso stesso di un gestore multi-sessione: con sei riquadri aperti non
 * si possono guardare tutti, e l'app sa già l'istante esatto in cui uno si
 * ferma ad aspettare — lo legge dal registro che Claude Code mantiene, con un
 * watcher e 120 ms di ritardo. Finora non ne faceva niente.
 *
 * Tre regole tengono la cosa utile invece che molesta:
 *
 * 1. Si avvisa solo sul PASSAGGIO a "attende input", non finché ci resta.
 *    Il registro viene riscritto spesso, e notificare ad ogni riscrittura
 *    produrrebbe una raffica per una sola attesa.
 * 2. Niente notifica se la finestra ha il fuoco: chi sta guardando l'app vede
 *    già il pallino cambiare colore.
 * 3. Solo le sessioni che appartengono a un riquadro. Il registro contiene
 *    ogni Claude Code vivo sulla macchina, comprese le sessioni aperte in un
 *    altro terminale: avvisare per quelle sarebbe intromettersi.
 */

/**
 * Identificativo del modello applicativo per Windows.
 *
 * Senza, le notifiche compaiono attribuite a "electron.app.Electron" — o non
 * compaiono affatto nel pacchetto. Deve combaciare con l'appId di
 * electron-builder, che è ciò che l'installer registra.
 */
const APP_USER_MODEL_ID = 'dev.nixo.claudemanager'

/** Stato precedente per sessione, per riconoscere il passaggio. */
const previous = new Map<string, RememberedSession>()

/**
 * Stato ricordato di una sessione, con quanti giri consecutivi manca.
 *
 * Il conteggio non e' un dettaglio: il registro viene RISCRITTO quando una
 * sessione cambia stato, e per un istante il file puo' non esserci. Se si
 * dimenticasse la sessione al primo giro di assenza, il ritorno con stato
 * 'waiting' sembrerebbe un primo avvistamento e l'avviso non partirebbe —
 * proprio nel momento piu' probabile perche' serva.
 */
interface RememberedSession {
  status: string
  missing: number
}

/** Giri di assenza consecutivi tollerati prima di dimenticare una sessione. */
const FORGET_AFTER_MISSES = 5
/** Riquadri noti, ripubblicati dal renderer ad ogni cambiamento. */
let known: MonitorPane[] = []
let enabled = true

export function initNotifier(): void {
  // Va impostato prima di costruire qualunque Notification.
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

export function setNotificationsEnabled(value: boolean): void {
  enabled = value
}

export function setKnownPanes(panes: MonitorPane[]): void {
  known = Array.isArray(panes) ? panes : []
}

export interface PendingNotice {
  pane: MonitorPane
  live: LiveSession
}

/**
 * Decide chi merita un avviso, e aggiorna lo stato precedente.
 *
 * Separata dall'effetto perché è qui che sta tutta la logica sbagliabile —
 * i passaggi, il primo avvistamento, l'appartenenza a un riquadro, la pulizia
 * — mentre mostrare la notifica è una riga. Così si può provare senza
 * Electron, invece di doversi fidare.
 */
export function decideNotices(
  sessions: LiveSession[],
  panes: MonitorPane[],
  seenBefore: Map<string, RememberedSession>
): PendingNotice[] {
  const present = new Set<string>()
  const out: PendingNotice[] = []

  for (const live of sessions) {
    present.add(live.sessionId)
    const before = seenBefore.get(live.sessionId)
    const now = live.status ?? 'unknown'
    seenBefore.set(live.sessionId, { status: now, missing: 0 })

    // Solo il passaggio, e solo verso l'attesa. `before` indefinito significa
    // primo avvistamento: all'avvio dell'app tutte le sessioni sarebbero
    // "nuove", e si aprirebbe una raffica di notifiche per stati che l'utente
    // conosce già.
    if (before === undefined || before.status === now || now !== 'waiting') continue

    const pane = panes.find((p) => p.claudeSessionId === live.sessionId)
    if (pane) out.push({ pane, live })
  }

  // Le sessioni sparite non si dimenticano subito: il registro viene riscritto
  // proprio quando lo stato cambia, e un'assenza di un solo giro e' normale.
  // Dimenticarla subito faceva sembrare il ritorno un primo avvistamento, e
  // l'avviso non partiva.
  for (const [id, ricordo] of [...seenBefore.entries()]) {
    if (present.has(id)) continue
    if (ricordo.missing + 1 >= FORGET_AFTER_MISSES) seenBefore.delete(id)
    else seenBefore.set(id, { ...ricordo, missing: ricordo.missing + 1 })
  }

  return out
}

/**
 * Confronta il registro col precedente e avvisa sui passaggi.
 *
 * Chiamata ad ogni cambiamento del registro, non a intervalli: la sorgente è
 * già basata su eventi.
 */
export function onLiveChange(sessions: LiveSession[], getWindow: () => BrowserWindow | null): void {
  const waiting = decideNotices(sessions, known, previous)
  if (waiting.length === 0) return

  const win = getWindow()
  // Chi sta guardando l'app vede già il pallino cambiare: una notifica di
  // sistema sopra la finestra che la genera è solo rumore. Una finestra
  // ridotta a icona però non mostra niente, anche se il sistema la considera
  // ancora attiva: va trattata come non guardata.
  const visibile = Boolean(win && win.isFocused() && !win.isMinimized())

  traceForTests(waiting, visibile)
  if (visibile) return

  notify(waiting, win)
}

function notify(waiting: PendingNotice[], win: BrowserWindow | null): void {

  // Il lampeggio nella barra delle applicazioni si fa comunque: resta visibile
  // anche se le notifiche di sistema sono disattivate o soppresse dal
  // Assistente notifiche di Windows.
  if (win && !win.isDestroyed()) win.flashFrame(true)

  if (!enabled || !Notification.isSupported()) return

  // Più sessioni insieme diventano un avviso solo: tre notifiche impilate per
  // un evento unico sono peggio di una che le riassume.
  const title =
    waiting.length === 1
      ? `${waiting[0].pane.label} attende una risposta`
      : `${waiting.length} sessioni attendono una risposta`

  const body =
    waiting.length === 1
      ? (waiting[0].live.waitingFor ?? waiting[0].pane.where)
      : waiting.map((w) => w.pane.label).join(' · ')

  const notification = new Notification({ title, body, silent: false })

  // Il clic porta all'app e al riquadro giusto: senza questo l'avviso dice
  // che qualcosa aspetta ma lascia il compito di cercarlo.
  notification.on('click', () => {
    const target = getMainWindow(win)
    if (!target) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    target.flashFrame(false)
    target.webContents.send('notify:focus-pane', waiting[0].pane.paneId)
  })

  notification.show()
}

/**
 * Lascia traccia degli avvisi mostrati, per i test end-to-end.
 *
 * Una notifica di Windows non è osservabile dall'esterno senza fotografare
 * l'intero schermo, e il processo principale di Electron non consegna
 * l'uscita standard a un file su Windows. Il ponte di sviluppo è il banco di
 * prova, quindi la traccia va nella sua cartella. Nel pacchetto la variabile
 * non è mai impostata e non si scrive niente.
 */
function traceForTests(waiting: PendingNotice[], soppressa: boolean): void {
  if (process.env.CM_DEV_BRIDGE !== '1') return
  try {
    const esito = soppressa ? 'SOPPRESSA(finestra a vista)' : 'MOSTRATA'
    const chi = waiting.map((w) => w.pane.paneId.slice(0, 8)).join(',')
    appendFileSync(
      join(app.getPath('userData'), 'dev-bridge', 'notifiche.log'),
      `${new Date().toISOString()} ${esito} ${chi}\n`,
      'utf8'
    )
  } catch {
    // Una traccia mancata non deve impedire l'avviso vero.
  }
}

/** La finestra principale resta il bersaglio anche se il fuoco è altrove. */
function getMainWindow(fallback: BrowserWindow | null): BrowserWindow | null {
  if (fallback && !fallback.isDestroyed()) return fallback
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

/** Spegne il lampeggio quando l'utente torna sull'app. */
export function clearAttention(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.flashFrame(false)
}
