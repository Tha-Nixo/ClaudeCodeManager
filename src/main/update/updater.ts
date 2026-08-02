import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'

/**
 * Aggiornamenti automatici dalle release di GitHub.
 *
 * Due scelte che determinano tutto il resto:
 *
 * 1. Si SCARICA da soli, ma non si installa da soli. Installare significa
 *    riavviare, e un riavvio a sorpresa ucciderebbe tutte le sessioni Claude
 *    aperte. L'installazione avviene alla chiusura dell'app, oppure quando
 *    l'utente la chiede.
 * 2. L'eseguibile portabile non puo' aggiornarsi. Non e' una limitazione
 *    nostra: un .exe portabile non ha un installer che possa sostituirlo
 *    mentre e' in esecuzione. Va riconosciuto e disattivato, altrimenti
 *    scaricherebbe decine di megabyte per poi fallire.
 */

// electron-updater e' CommonJS: la destrutturazione diretta non funziona
// nel bundle ESM del main.
const { autoUpdater } = electronUpdater

/** Attesa prima del primo controllo: l'avvio deve restare veloce. */
const FIRST_CHECK_MS = 20_000
/** Un controllo al giorno basta per un'app che si tiene aperta a lungo. */
const INTERVAL_MS = 24 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle' }
let notify: ((s: UpdateState) => void) | null = null
let timer: NodeJS.Timeout | null = null

function setState(next: UpdateState): void {
  state = next
  notify?.(state)
}

/**
 * electron-builder popola PORTABLE_EXECUTABLE_DIR solo nel target portabile:
 * e' il modo affidabile per distinguerlo dall'installazione NSIS.
 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

/**
 * In sviluppo l'updater e' spento, il che lo rende anche non verificabile:
 * un aggiornamento che non funziona non se ne accorge nessuno finche' non
 * serve. Con CM_UPDATE_DEV=1 si accende usando l'app-update.yml prodotto
 * dall'ultima build, cosi' si puo' controllare che il canale sia davvero
 * raggiungibile. Nel pacchetto la variabile non cambia niente.
 */
const devOverride = (): boolean => !app.isPackaged && process.env.CM_UPDATE_DEV === '1'

/** Perche' gli aggiornamenti non sono attivi, se non lo sono. */
function unsupportedReason(): string | null {
  if (!app.isPackaged && !devOverride()) return 'Aggiornamenti non attivi durante lo sviluppo.'
  if (isPortable()) {
    return "L'eseguibile portabile non puo' aggiornarsi da solo: scarica la nuova versione dalle release."
  }
  return null
}

export function currentState(): UpdateState {
  return state
}

export function initUpdater(send: (s: UpdateState) => void): void {
  notify = send

  const blocked = unsupportedReason()
  if (blocked) {
    setState({ status: 'unsupported', message: blocked })
    return
  }

  // Scarica da solo, installa alla chiusura: vedi la nota in testa al file.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  if (devOverride()) {
    // Senza questo electron-updater rifiuta di partire fuori da un pacchetto.
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))

  autoUpdater.on('update-available', (info) =>
    setState({ status: 'downloading', version: info.version, percent: 0 })
  )

  autoUpdater.on('update-not-available', () =>
    setState({ status: 'idle', checkedAt: Date.now() })
  )

  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', version: state.version, percent: Math.round(p.percent) })
  )

  autoUpdater.on('update-downloaded', (info) =>
    setState({
      status: 'ready',
      version: info.version,
      // Le note della release possono essere HTML o una lista: qui serve
      // testo, e comunque il dettaglio sta nel CHANGELOG.
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    })
  )

  autoUpdater.on('error', (err) =>
    // Un aggiornamento fallito non deve disturbare: si annota e si riprova al
    // controllo successivo. Nessun dialogo modale.
    setState({ status: 'error', message: err?.message || 'Controllo non riuscito.' })
  )

  timer = setTimeout(() => {
    void check()
    timer = setInterval(() => void check(), INTERVAL_MS)
  }, FIRST_CHECK_MS)
}

export async function check(): Promise<UpdateState> {
  if (state.status === 'unsupported') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setState({
      status: 'error',
      message: err instanceof Error ? err.message : 'Controllo non riuscito.'
    })
  }
  return state
}

/** Riavvia e installa. Chiamata solo su richiesta esplicita. */
export function installNow(): void {
  if (state.status !== 'ready') return
  autoUpdater.quitAndInstall()
}

export function stopUpdater(): void {
  if (timer) {
    clearTimeout(timer)
    clearInterval(timer)
    timer = null
  }
  notify = null
}
