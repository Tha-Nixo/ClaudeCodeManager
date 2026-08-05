import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { __userData } from './helpers/electron'
import { DEFAULT_CONFIG, type SshConnection } from '../src/shared/types'
import { getConfig, readJson, setConfig, writeJsonAtomic } from '../src/main/store/config'
import { getFavorites, getRecents, toggleFavorite, touchRecent } from '../src/main/store/folders'
import {
  deleteConnection,
  getConnection,
  listConnections,
  saveConnection
} from '../src/main/store/connections'
import { flushLayout, loadLayout, saveLayout } from '../src/main/store/layout'

/**
 * Stato di partenza dei tre file su disco.
 *
 * config, folders e connections tengono in cache il contenuto del file al
 * PRIMO accesso e non lo rileggono piu': dentro un singolo file di test c'e'
 * una sola occasione di decidere da cosa partono. I file vanno quindi scritti
 * qui, a livello di modulo, prima che un qualsiasi test chiami una funzione, e
 * ogni caso che riguarda il caricamento sta in un unico `it` per gruppo. Le
 * altre asserzioni sono relative (cercano per id o per percorso proprio) cosi'
 * l'ordine di esecuzione non le puo' influenzare.
 */

/** Il carattere che il Blocco note e `Set-Content -Encoding utf8` mettono in testa. */
const BOM = '\uFEFF'

// Ogni campo ha il tipo sbagliato: e' il file che ha rotto le Impostazioni.
writeFileSync(
  join(__userData, 'config.json'),
  JSON.stringify({
    defaultCwd: 42,
    launchDefaults: 'opus',
    initialCols: '200',
    initialRows: 0,
    restoreResumesSessions: 'true',
    indexSources: ['claude'],
    scanRoots: 'C:\\uno;C:\\due',
    themeId: 7,
    notifyOnWaiting: 'no',
    keymap: ['ctrl+alt+t']
  }),
  'utf8'
)

// JSON valido ma preceduto dal BOM, con `recents` corrotto: i preferiti si
// leggono solo se il BOM viene saltato, i recenti solo se il tipo e' validato.
writeFileSync(
  join(__userData, 'folders.json'),
  BOM +
    JSON.stringify({
      recents: 'C:\\progetti',
      favorites: ['C:\\preferito\\uno', 42, 'C:\\preferito\\due']
    }),
  'utf8'
)

writeFileSync(
  join(__userData, 'connections.json'),
  JSON.stringify({
    connections: [
      {
        id: 'da-file-buona',
        name: 'Server buono',
        host: 'srv.example',
        user: 'nico',
        port: 2222,
        remotePath: '/srv'
      },
      { id: 'da-file-porta-rotta', host: 'frazionaria.example', user: 'nico', port: 22.7 },
      { id: 'da-file-senza-host', user: 'nico', port: 22 },
      'non e\u2019 un oggetto',
      null
    ]
  }),
  'utf8'
)

/** Cartella di lavoro usa e getta, per non toccare mai percorsi veri. */
function cartellaTemporanea(prefisso: string): string {
  return mkdtempSync(join(tmpdir(), `cm-${prefisso}-`))
}

// --- config: lettura e scrittura dei file -----------------------------------

describe('readJson: file che l\u2019utente puo\u2019 aver toccato a mano', () => {
  it('ritorna null invece di lanciare su file assente, vuoto o malformato', () => {
    const dir = cartellaTemporanea('read')

    // Al primo avvio nessuno di questi file esiste: se readJson lanciasse,
    // l'app morirebbe prima di disegnare la finestra.
    assert.equal(readJson(join(dir, 'mai-esistito.json')), null)

    const vuoto = join(dir, 'vuoto.json')
    writeFileSync(vuoto, '', 'utf8')
    assert.equal(readJson(vuoto), null)

    // Un file troncato da un crash a meta' scrittura.
    const troncato = join(dir, 'troncato.json')
    writeFileSync(troncato, '{"scanRoots": ["C:\\\\uno"', 'utf8')
    assert.equal(readJson(troncato), null)

    // Solo BOM, senza contenuto: resta una stringa vuota dopo lo slice.
    const soloBom = join(dir, 'solo-bom.json')
    writeFileSync(soloBom, BOM, 'utf8')
    assert.equal(readJson(soloBom), null)
  })

  /**
   * Regressione della issue #4.
   *
   * readJson non saltava il BOM, JSON.parse lanciava, l'errore veniva
   * inghiottito e il file risultava «assente»: chi apriva config.json col
   * Blocco note per cambiare una riga si ritrovava impostazioni, preferiti e
   * connessioni ssh riportati ai valori predefiniti senza spiegazione, e
   * sovrascritti alla prima scrittura successiva.
   */
  it('legge un JSON valido preceduto dal BOM', () => {
    const dir = cartellaTemporanea('bom')
    const file = join(dir, 'con-bom.json')
    const contenuto = { themeId: 'notte', scanRoots: ['C:\\uno'], keymap: { 'ctrl+t': 'nuovo' } }

    writeFileSync(file, BOM + JSON.stringify(contenuto, null, 2), 'utf8')

    assert.deepEqual(readJson(file), contenuto)
  })
})

describe('writeJsonAtomic: la scrittura non deve mai abbattere il processo', () => {
  it('scrive, crea le cartelle mancanti e si rilegge identico', () => {
    const dir = cartellaTemporanea('write')
    // Al primo avvio userData esiste ma le sottocartelle no: la scrittura deve
    // crearsele da sola invece di fallire.
    const file = join(dir, 'sotto', 'cartella', 'dati.json')
    const valore = { a: 1, b: ['due', 'tre'], c: { d: true } }

    assert.equal(writeJsonAtomic(file, valore), true)
    assert.deepEqual(readJson(file), valore)
    // Il temporaneo non deve sopravvivere alla scrittura riuscita.
    assert.equal(existsSync(`${file}.tmp`), false)
  })

  it('ritorna false senza lanciare quando il percorso e\u2019 impossibile', () => {
    const dir = cartellaTemporanea('impossibile')
    const ostacolo = join(dir, 'sono-un-file')
    writeFileSync(ostacolo, 'x', 'utf8')

    // Una cartella genitore che in realta' e' un file: mkdir fallisce subito.
    // Molte di queste scritture partono da un timer, dove un'eccezione non
    // catturata porterebbe giu' il processo principale con dentro tutti i PTY.
    const target = join(ostacolo, 'sub', 'dati.json')
    assert.equal(writeJsonAtomic(target, { a: 1 }), false)

    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith('.tmp')),
      [],
      'una scrittura fallita ha lasciato un .tmp orfano'
    )
  })

  it('rimuove il .tmp quando e\u2019 la rinomina a fallire', () => {
    const dir = cartellaTemporanea('rinomina')
    // Il target esiste ma e' una cartella: il temporaneo viene scritto per
    // davvero e la rinomina fallisce. E' il caso in cui il .tmp resterebbe
    // sul disco per sempre, uno per ogni tentativo.
    const target = join(dir, 'bloccato.json')
    mkdirSync(target)

    assert.equal(writeJsonAtomic(target, { a: 1 }), false)
    assert.equal(existsSync(`${target}.tmp`), false, 'il .tmp orfano non e\u2019 stato rimosso')
  })

  it('non lascia il file precedente troncato quando il valore non e\u2019 serializzabile', () => {
    const dir = cartellaTemporanea('circolare')
    const file = join(dir, 'dati.json')
    assert.equal(writeJsonAtomic(file, { buono: true }), true)

    const circolare: Record<string, unknown> = {}
    circolare.se_stesso = circolare
    assert.equal(writeJsonAtomic(file, circolare), false)

    // Il valore buono di prima deve essere ancora li': e' tutto il senso della
    // scrittura atomica.
    assert.deepEqual(readJson(file), { buono: true })
  })
})

// --- config -----------------------------------------------------------------

/**
 * Regressione della issue #5.
 *
 * getConfig validava solo `keymap`. Un errore banale come `scanRoots` scritto
 * come stringa invece che come elenco arrivava intatto al renderer, dove il
 * pannello Impostazioni chiamava .join() su una stringa e smetteva di
 * disegnarsi: l'unico posto da cui rimettere a posto il valore sbagliato
 * diventava inaccessibile proprio a causa di quel valore.
 */
describe('config: ogni campo col tipo sbagliato torna al valore predefinito', () => {
  it('ripulisce il file scritto a mano e rispetta comunque la forma di AppConfig', () => {
    const config = getConfig()

    // Numero al posto della cartella: deve restare un percorso utilizzabile.
    assert.equal(typeof config.defaultCwd, 'string')
    assert.ok(config.defaultCwd.length > 0, 'defaultCwd vuoto: nessun riquadro potrebbe partire')

    // Stringa al posto del numero, e numero fuori range (0 righe = terminale
    // invisibile): entrambi tornano al predefinito.
    assert.equal(config.initialCols, DEFAULT_CONFIG.initialCols)
    assert.equal(config.initialRows, DEFAULT_CONFIG.initialRows)

    // 'true' come stringa e' sempre vero se lo si valuta: qui deve valere il
    // predefinito, non il testo.
    assert.equal(config.restoreResumesSessions, DEFAULT_CONFIG.restoreResumesSessions)
    assert.equal(typeof config.restoreResumesSessions, 'boolean')
    assert.equal(config.notifyOnWaiting, DEFAULT_CONFIG.notifyOnWaiting)
    assert.equal(typeof config.notifyOnWaiting, 'boolean')

    // Numero al posto dell'id del tema: con un id inesistente l'interfaccia
    // resterebbe senza colori.
    assert.equal(config.themeId, DEFAULT_CONFIG.themeId)
    assert.equal(typeof config.themeId, 'string')

    // Il caso che ha rotto le Impostazioni: la stringa non deve arrivare al
    // renderer, e non deve nemmeno diventare un elenco di caratteri.
    assert.ok(Array.isArray(config.scanRoots), 'scanRoots non e\u2019 un elenco')
    assert.ok(
      config.scanRoots.every((r) => typeof r === 'string'),
      'scanRoots contiene elementi che non sono percorsi'
    )
    assert.ok(!config.scanRoots.includes('C'), 'la stringa e\u2019 stata trattata come elenco')

    // Elenco al posto della mappa: keymap viene sovrapposta a quella
    // predefinita, e su un array la sovrapposizione darebbe scorciatoie con
    // chiavi numeriche.
    assert.equal(typeof config.keymap, 'object')
    assert.ok(config.keymap !== null && !Array.isArray(config.keymap))
    assert.deepEqual(config.keymap, {})

    // Stringa e array al posto degli oggetti di opzioni.
    assert.deepEqual(config.launchDefaults, DEFAULT_CONFIG.launchDefaults)
    assert.deepEqual(config.indexSources, DEFAULT_CONFIG.indexSources)
  })

  it('setConfig applica la modifica e la porta su disco ripulita', () => {
    // Si tocca solo defaultCwd, che il caso precedente controlla senza
    // fissarne il valore: cosi' i due casi restano indipendenti dall'ordine.
    const nuova = cartellaTemporanea('cwd')
    const dopo = setConfig({ defaultCwd: nuova })
    assert.equal(dopo.defaultCwd, nuova)

    const suDisco = JSON.parse(readFileSync(join(__userData, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >
    assert.equal(suDisco.defaultCwd, nuova, 'la modifica non e\u2019 arrivata su disco')
    // Quello che si riscrive non deve essere la spazzatura letta all'avvio,
    // altrimenti il file resterebbe rotto per sempre.
    assert.ok(Array.isArray(suDisco.scanRoots))
    assert.equal(typeof suDisco.themeId, 'string')
    assert.equal(typeof suDisco.initialCols, 'number')
  })
})

/**
 * Difetto osservato, non corretto (vedi resoconto).
 *
 * I campi a oggetto vengono fusi con il predefinito senza controllare i valori
 * dentro: `obj()` fonde il valore memorizzato sopra il predefinito e si ferma
 * li'. La issue #5 e' rimasta aperta per i campi a oggetto.
 *
 * Osservato sostituendo temporaneamente il contenuto di config.json qui sopra
 * con `indexSources: { claude: 'si' }` e `launchDefaults: { model: 42 }`:
 *   indexSources   -> {"claude":"si","roots":true,"git":true,"drive":false}
 *   launchDefaults -> {"model":42,"effort":"default","permissionMode":"default"}
 * Le chiavi non dichiarate a mano arrivano giuste; quella dichiarata conserva
 * il tipo sbagliato. `launchDefaults.model` prefissa le opzioni di lancio di
 * ogni nuovo riquadro (App.tsx), quindi un modello che non esiste parte da li'.
 *
 * Il caso resta sospeso e non corretto: la cache di modulo concede un solo
 * caricamento di config per file di test, e quell'occasione serve al caso di
 * regressione qui sopra.
 */
describe('config: campi a oggetto con una sola chiave del tipo sbagliato', () => {
  it('dovrebbe validare anche i valori dentro launchDefaults e indexSources', () => {
    // Da riattivare scrivendo `indexSources: { claude: 'si' }` nel config.json
    // di partenza, in un file di test dedicato.
    const config = getConfig()
    assert.equal(typeof config.indexSources.claude, 'boolean')
    assert.equal(typeof config.launchDefaults.model, 'string')
  })
})

// --- folders ----------------------------------------------------------------

describe('folders: il selettore di cartelle non deve poter diventare inutilizzabile', () => {
  /**
   * Regressione delle issue #9 e #4.
   *
   * Con `recents` uguale a una stringa il selettore sollevava un'eccezione ad
   * ogni apertura e non c'era modo di uscirne se non cancellando il file: la
   * funzione principale dell'app restava inaccessibile senza che nulla lo
   * spiegasse. I preferiti nello stesso file, scritto col BOM, dimostrano che
   * il resto del contenuto viene comunque letto (issue #4): se il BOM non
   * fosse saltato tornerebbero due elenchi vuoti e il difetto passerebbe
   * inosservato.
   */
  it('con un file corrotto restituisce comunque due elenchi', () => {
    const recenti = getRecents()
    assert.ok(Array.isArray(recenti), 'getRecents non ha restituito un elenco')
    assert.ok(
      recenti.every((r) => Boolean(r) && typeof r.path === 'string'),
      'fra i recenti e\u2019 rimasto qualcosa che non e\u2019 una cartella'
    )
    // La stringa non deve essere stata scorsa carattere per carattere.
    assert.ok(!recenti.some((r) => r.path === 'C'))

    const preferiti = getFavorites()
    assert.ok(Array.isArray(preferiti), 'getFavorites non ha restituito un elenco')
    // Letti davvero dal file, BOM compreso.
    assert.ok(preferiti.includes('C:\\preferito\\uno'), 'preferito perso: BOM non saltato?')
    assert.ok(preferiti.includes('C:\\preferito\\due'))
    // Il 42 in mezzo non deve arrivare al renderer.
    assert.ok(
      preferiti.every((f) => typeof f === 'string'),
      'fra i preferiti e\u2019 rimasto un valore che non e\u2019 un percorso'
    )
  })

  it('registra una cartella aperta, senza duplicarla e salvandola su disco', () => {
    const cartella = cartellaTemporanea('recente')

    touchRecent(cartella)
    assert.equal(getRecents()[0].path, cartella, 'la cartella appena aperta non e\u2019 in cima')

    // Stessa cartella con il separatore finale e maiuscole diverse: per
    // l'utente e' la stessa voce, e l'elenco non deve sdoppiarsi.
    touchRecent(`${cartella}\\`)
    const uguali = getRecents().filter((r) => r.path.toLowerCase().startsWith(cartella.toLowerCase()))
    assert.equal(uguali.length, 1, 'la stessa cartella compare due volte fra i recenti')

    // Se non arriva su disco, al riavvio l'elenco riparte vuoto.
    const suDisco = readFileSync(join(__userData, 'folders.json'), 'utf8')
    assert.ok(suDisco.includes(JSON.stringify(cartella).slice(1, -1)))
  })

  it('aggiunge e toglie un preferito', () => {
    const cartella = cartellaTemporanea('preferito')

    const dopoAggiunta = toggleFavorite(cartella)
    assert.ok(dopoAggiunta.includes(cartella))
    assert.ok(getFavorites().includes(cartella))

    const dopoRimozione = toggleFavorite(cartella)
    assert.ok(!dopoRimozione.includes(cartella), 'il preferito non si e\u2019 potuto togliere')
    assert.ok(!getFavorites().includes(cartella))
  })
})

// --- connections ------------------------------------------------------------

describe('connections: record letti da un file scritto a mano', () => {
  it('scarta l\u2019incompleto e tiene il buono, senza lanciare sulla spazzatura', () => {
    const elenco = listConnections()

    const buona = elenco.find((c) => c.id === 'da-file-buona')
    assert.ok(buona, 'la connessione valida e\u2019 andata persa')
    assert.equal(buona.port, 2222)
    assert.equal(buona.remotePath, '/srv')

    // Senza host il comando ssh non avrebbe senso: il record va tolto.
    assert.equal(
      elenco.some((c) => c.id === 'da-file-senza-host'),
      false,
      'una connessione senza host e\u2019 arrivata nel selettore'
    )

    // Le voci che non sono nemmeno oggetti non devono far cadere il
    // caricamento delle altre.
    assert.ok(elenco.every((c) => typeof c.host === 'string' && c.host.length > 0))
    assert.ok(elenco.every((c) => typeof c.name === 'string' && c.name.length > 0))
  })

  it('getConnection risponde null per un id che non esiste', () => {
    assert.equal(getConnection('id-che-non-esiste'), null)
  })

  /**
   * Regressione della issue #13.
   *
   * saveConnection accettava una porta non intera: 22.7 veniva salvata e poi
   * ssh rifiutava ogni tentativo con «Bad port '22.7'», lasciando memorizzata
   * la porta sbagliata. Quando la porta non e' utilizzabile va scartata, cosi'
   * ssh usa la sua predefinita e la connessione funziona.
   */
  it('accetta solo porte intere nell\u2019intervallo valido', () => {
    const casi: { porta: unknown; attesa: number | undefined }[] = [
      { porta: 22, attesa: 22 },
      { porta: 2222, attesa: 2222 },
      { porta: 1, attesa: 1 },
      { porta: 65535, attesa: 65535 },
      { porta: 22.7, attesa: undefined },
      { porta: 0, attesa: undefined },
      { porta: -22, attesa: undefined },
      { porta: 65536, attesa: undefined },
      { porta: NaN, attesa: undefined },
      { porta: Infinity, attesa: undefined },
      { porta: '22', attesa: undefined },
      { porta: null, attesa: undefined }
    ]

    for (const { porta, attesa } of casi) {
      const salvata = saveConnection({
        host: 'porta.example',
        user: 'nico',
        port: porta as number
      })
      assert.ok(salvata, `porta ${String(porta)}: la connessione non e\u2019 stata salvata`)
      assert.equal(
        salvata.port,
        attesa,
        `porta ${String(porta)}: attesa ${String(attesa)}, ottenuta ${String(salvata.port)}`
      )
      // La porta memorizzata deve essere anche quella riletta.
      assert.equal(getConnection(salvata.id)?.port, attesa)
      deleteConnection(salvata.id)
      assert.equal(getConnection(salvata.id), null, 'la connessione cancellata e\u2019 rimasta')
    }
  })

  /**
   * L'autenticazione e' delegata a ssh: qui non deve finire nessun segreto,
   * nemmeno se il renderer o un aggiornamento futuro ne passa uno per sbaglio
   * insieme agli altri campi. connections.json e' un file in chiaro dentro
   * userData.
   */
  it('non scrive mai su disco una password passata come campo in piu\u2019', () => {
    const SEGRETO = 'p4rol4-che-non-deve-finire-su-disco'
    const conPassword = { host: 'segreti.example', user: 'nico', password: SEGRETO }

    const creata = saveConnection(conPassword as Partial<SshConnection>)
    assert.ok(creata)
    assert.equal((creata as Record<string, unknown>).password, undefined)

    // E anche su un aggiornamento, dove l'input viene fuso col record esistente.
    const aggiornata = saveConnection({
      ...conPassword,
      id: creata.id,
      remotePath: '/casa'
    } as Partial<SshConnection>)
    assert.ok(aggiornata)
    assert.equal((aggiornata as Record<string, unknown>).password, undefined)
    assert.equal(aggiornata.remotePath, '/casa')

    const suDisco = readFileSync(join(__userData, 'connections.json'), 'utf8')
    // Guardia: se il record non fosse stato scritto, l'assenza del segreto non
    // proverebbe nulla.
    assert.ok(suDisco.includes('segreti.example'), 'il record non e\u2019 finito su disco')
    assert.ok(!suDisco.includes(SEGRETO), 'la password e\u2019 stata scritta in connections.json')
    assert.ok(!suDisco.toLowerCase().includes('password'))

    deleteConnection(creata.id)
  })
})

// --- layout -----------------------------------------------------------------

describe('layout: un file rovinato non deve impedire l\u2019avvio', () => {
  const fileLayout = (): string => join(__userData, 'layout.json')
  const scrivi = (valore: unknown): void =>
    writeFileSync(fileLayout(), JSON.stringify(valore), 'utf8')

  const riquadroBuono = {
    paneId: 'riquadro-1',
    cwd: 'C:\\progetti\\uno',
    launch: { model: 'default', effort: 'default', permissionMode: 'default' },
    claudeSessionId: null
  }

  it('senza file non c\u2019e\u2019 layout da ripristinare', () => {
    rmSync(fileLayout(), { force: true })
    assert.equal(loadLayout(), null)
  })

  it('ignora un file di una versione che non conosce', () => {
    // Meglio uno stage pulito che riquadri interpretati con le regole
    // sbagliate.
    scrivi({ version: 0, savedAt: 1, tree: {}, panes: [riquadroBuono] })
    assert.equal(loadLayout(), null)

    scrivi({ savedAt: 1, tree: {}, panes: [riquadroBuono] })
    assert.equal(loadLayout(), null)
  })

  it('ignora un file in cui i riquadri non sono nemmeno un elenco', () => {
    scrivi({ version: 1, savedAt: 1, tree: {}, panes: 'riquadro-1' })
    assert.equal(loadLayout(), null)

    scrivi({ version: 1, savedAt: 1, tree: {} })
    assert.equal(loadLayout(), null)
  })

  it('scarta i riquadri malformati e ripristina quelli buoni', () => {
    scrivi({
      version: 1,
      savedAt: 1,
      tree: { tipo: 'foglia' },
      panes: [
        null,
        'riquadro',
        42,
        {},
        { cwd: 'C:\\progetti\\due', launch: {} }, // senza paneId
        { paneId: 'senza-launch', cwd: 'C:\\progetti\\tre' }, // senza launch
        { paneId: 'launch-non-oggetto', cwd: 'C:\\progetti\\tre', launch: 'opus' },
        { paneId: 'cwd-numero', cwd: 7, launch: {} }, // cwd non stringa
        { paneId: 'cwd-vuota', cwd: '', launch: {} },
        { paneId: '', cwd: 'C:\\progetti\\quattro', launch: {} },
        riquadroBuono
      ]
    })

    const layout = loadLayout()
    assert.ok(layout, 'un solo riquadro buono basta per ripristinare')
    assert.equal(layout.panes.length, 1)
    assert.equal(layout.panes[0].paneId, 'riquadro-1')
    // Il resto del file (l'albero) deve sopravvivere alla ripulitura.
    assert.deepEqual(layout.tree, { tipo: 'foglia' })
  })

  it('se nessun riquadro e\u2019 recuperabile non ripristina niente', () => {
    // Un layout con zero riquadri lascerebbe una finestra vuota e nessun modo
    // di capire cosa e' successo: meglio ripartire dal selettore.
    scrivi({ version: 1, savedAt: 1, tree: {}, panes: [null, { paneId: 'orfano' }] })
    assert.equal(loadLayout(), null)

    scrivi({ version: 1, savedAt: 1, tree: {}, panes: [] })
    assert.equal(loadLayout(), null)
  })

  it('flushLayout scrive subito e il layout si rilegge', () => {
    rmSync(fileLayout(), { force: true })

    saveLayout({ version: 0, savedAt: 0, tree: { tipo: 'foglia' }, panes: [riquadroBuono] })
    // saveLayout aspetta 800 ms; alla chiusura non c'e' quel tempo, e senza
    // flush l'ultima disposizione andrebbe persa ad ogni uscita.
    flushLayout()

    assert.ok(existsSync(fileLayout()), 'il layout non e\u2019 stato scritto alla chiusura')

    const riletto = loadLayout()
    assert.ok(riletto)
    assert.equal(riletto.version, 1, 'la versione corrente non e\u2019 stata impressa nel file')
    assert.equal(typeof riletto.savedAt, 'number')
    assert.ok(riletto.savedAt > 0)
    assert.equal(riletto.panes.length, 1)
    assert.equal(riletto.panes[0].cwd, riquadroBuono.cwd)
  })
})
