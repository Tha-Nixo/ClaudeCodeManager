import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'

/**
 * Aggiornamenti dalle release di GitHub.
 *
 * Tre scelte che determinano tutto il resto:
 *
 * 1. Si SCARICA da soli, ma non si installa da soli. Installare significa
 *    riavviare, e un riavvio a sorpresa ucciderebbe tutte le sessioni Claude
 *    aperte. L'installazione avviene alla chiusura dell'app, oppure quando
 *    l'utente la chiede.
 * 2. L'eseguibile portabile CONTROLLA ma non scarica. Non puo' sostituirsi da
 *    solo — un .exe in esecuzione non si puo' rimpiazzare, e il file pubblicato
 *    per l'aggiornamento automatico e' comunque l'installer, che trasformerebbe
 *    a sorpresa una copia portabile in una installata. Sapere che esiste una
 *    versione nuova pero' serve lo stesso, quindi il controllo si fa e il
 *    risultato si mostra, con il collegamento da cui scaricarla.
 * 3. In sviluppo e' tutto spento, salvo CM_UPDATE_DEV=1.
 */

/**
 * Deve corrispondere al blocco `publish` di electron-builder.yml. Serve solo a
 * comporre l'indirizzo della pagina da aprire: il canale vero lo legge
 * electron-updater da app-update.yml, generato da quello stesso blocco.
 */
const RELEASES_URL = 'https://github.com/Tha-Nixo/ClaudeCodeManager/releases'

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

/** Pagina di una versione, da aprire quando l'installazione va fatta a mano. */
function releasePage(version?: string): string {
  return version ? `${RELEASES_URL}/tag/v${version}` : `${RELEASES_URL}/latest`
}

/** Quanto testo di anteprima delle novita' ha senso tenere. */
const NOTES_LIMIT = 240

/**
 * Riduce le note della release a testo semplice.
 *
 * GitHub le restituisce come HTML gia' reso. Farlo attraversare l'IPC cosi'
 * com'e' significa consegnare al renderer del markup di provenienza remota:
 * oggi nessuno lo mostra, ma basta che un giorno qualcuno lo renda con
 * dangerouslySetInnerHTML perche' diventi un'iniezione. Meglio che oltre
 * questo confine passi solo testo.
 */
function plainNotes(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined

  const text = raw
    // I blocchi diventano spazi, altrimenti le parole si incollano fra loro.
    .replace(/<\/(p|li|h\d|tr|div)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[m] ??
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return undefined
  return text.length > NOTES_LIMIT ? `${text.slice(0, NOTES_LIMIT).trimEnd()}…` : text
}

export function currentState(): UpdateState {
  return state
}

export function initUpdater(send: (s: UpdateState) => void): void {
  notify = send

  if (!app.isPackaged && !devOverride()) {
    setState({ status: 'unsupported', message: 'Aggiornamenti non attivi durante lo sviluppo.' })
    return
  }

  // Nel portabile si controlla soltanto: vedi la nota in testa al file.
  const manual = isPortable()

  autoUpdater.autoDownload = !manual
  autoUpdater.autoInstallOnAppQuit = !manual
  autoUpdater.logger = null

  if (devOverride()) {
    // Senza questo electron-updater rifiuta di partire fuori da un pacchetto.
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))

  autoUpdater.on('update-available', (info) =>
    setState(
      manual
        ? {
            status: 'available',
            version: info.version,
            releaseUrl: releasePage(info.version),
            notes: plainNotes(info.releaseNotes),
            message:
              'La copia portabile non si aggiorna da sola: scarica il nuovo eseguibile e sostituisci quello attuale.'
          }
        : { status: 'downloading', version: info.version, percent: 0 }
    )
  )

  autoUpdater.on('update-not-available', () =>
    setState({ status: 'idle', checkedAt: Date.now() })
  )

  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', version: state.version, percent: Math.round(p.percent) })
  )

  autoUpdater.on('update-downloaded', (info) =>
    setState({ status: 'ready', version: info.version, notes: plainNotes(info.releaseNotes) })
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

/** Pagina da cui scaricare a mano, quando l'app non puo' aggiornarsi da sola. */
export function releaseUrl(): string {
  return state.releaseUrl ?? releasePage()
}

export function stopUpdater(): void {
  if (timer) {
    clearTimeout(timer)
    clearInterval(timer)
    timer = null
  }
  notify = null
}
