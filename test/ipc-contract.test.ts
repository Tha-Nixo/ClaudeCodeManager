import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * Contratto IPC fra preload e main, verificato sul testo dei sorgenti.
 *
 * Un canale che il preload invoca ma che il main non gestisce non e' un errore
 * di compilazione: i due lati si parlano per stringhe, e TypeScript vede solo
 * la firma di `CmApi`. Il guasto compare a runtime, e solo quando l'utente
 * arriva su quella funzione: una voce di menu che non fa niente, un pannello
 * che resta vuoto, un `Error: No handler registered` nella console che nessuno
 * guarda. Anche l'accoppiata sbagliata rompe tutto in silenzio: `invoke` su un
 * canale registrato con `ipcMain.on` non riceve mai risposta e la promessa
 * resta appesa per sempre.
 *
 * Il controllo e' strutturale di proposito: leggere i sorgenti costa niente e
 * copre TUTTI i canali, mentre provarli davvero richiederebbe un Electron vivo
 * e un giro di interfaccia per ciascuno.
 */

/** Radice del repository: risalita da dove gira il bundle, senza percorsi personali. */
function radiceRepo(): string {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'main', 'ipc.ts'))) return dir
    dir = join(dir, '..')
  }
  return process.cwd()
}

const RADICE = radiceRepo()

/**
 * Toglie i commenti, cosi' un canale nominato in una spiegazione non conta
 * come codice. La rimozione e' volutamente prudente: i commenti di blocco si
 * tolgono solo se aprono la riga (in `ssh/remote.ts` c'e' una stringa di shell
 * che contiene `/*`), e il `//` si taglia solo fuori dalle stringhe, riga per
 * riga. Sbagliando si lascia un commento di troppo, mai codice di meno.
 */
function senzaCommenti(sorgente: string): string {
  const senzaBlocchi = sorgente.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')

  return senzaBlocchi
    .split('\n')
    .map((riga) => {
      let apice: string | null = null
      for (let i = 0; i < riga.length; i++) {
        const c = riga[i]
        if (apice) {
          if (c === '\\') i++
          else if (c === apice) apice = null
          continue
        }
        if (c === "'" || c === '"' || c === '`') apice = c
        else if (c === '/' && riga[i + 1] === '/') return riga.slice(0, i)
      }
      return riga
    })
    .join('\n')
}

/**
 * Estrae i nomi di canale dal primo argomento di una chiamata.
 * Tollera apici singoli o doppi e spazi attorno alle parentesi.
 */
function canaliDi(sorgente: string, chiamata: string): Set<string> {
  const re = new RegExp(`${chiamata}\\s*\\(\\s*(['"\`])([^'"\`]+)\\1`, 'g')
  const out = new Set<string>()
  for (const m of sorgente.matchAll(re)) out.add(m[2])
  return out
}

/** Ogni .ts sotto src/main, sia in radice sia in una sottocartella. */
function sorgentiDelMain(): { file: string; testo: string }[] {
  const base = join(RADICE, 'src', 'main')
  const out: { file: string; testo: string }[] = []

  for (const voce of readdirSync(base, { withFileTypes: true })) {
    if (voce.isFile() && voce.name.endsWith('.ts')) {
      out.push({ file: `src/main/${voce.name}`, testo: leggi(join(base, voce.name)) })
      continue
    }
    if (!voce.isDirectory()) continue
    for (const dentro of readdirSync(join(base, voce.name), { withFileTypes: true })) {
      if (dentro.isFile() && dentro.name.endsWith('.ts')) {
        out.push({
          file: `src/main/${voce.name}/${dentro.name}`,
          testo: leggi(join(base, voce.name, dentro.name))
        })
      }
    }
  }
  return out
}

function leggi(percorso: string): string {
  return senzaCommenti(readFileSync(percorso, 'utf8'))
}

const IPC = leggi(join(RADICE, 'src', 'main', 'ipc.ts'))
const PRELOAD = leggi(join(RADICE, 'src', 'preload', 'index.ts'))
const MAIN = sorgentiDelMain()

/** Registrati nel main. */
const HANDLE = canaliDi(IPC, 'ipcMain\\.handle')
const ON = canaliDi(IPC, 'ipcMain\\.on')

/** Usati dal preload. */
const INVOKE = canaliDi(PRELOAD, 'ipcRenderer\\.invoke')
const SEND = canaliDi(PRELOAD, 'ipcRenderer\\.send')
const ASCOLTATI = canaliDi(PRELOAD, 'ipcRenderer\\.on')

/**
 * Nomi delle funzioni che inoltrano un canale ricevuto come parametro.
 *
 * `monitor/state.ts` non scrive `webContents.send('monitor:state')`: passa il
 * nome a `broadcast`, che lo gira a tutte le finestre. Cercando solo le
 * chiamate con il nome in chiaro si concluderebbe che `monitor:state` non
 * viene mai emesso, e il test accuserebbe un difetto che non c'e'.
 */
function inoltratori(sorgente: string): string[] {
  const nomi = new Set<string>()
  for (const m of sorgente.matchAll(/\.send\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    const prima = sorgente.slice(0, m.index ?? 0)
    const dichiarazioni = [...prima.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
    const ultima = dichiarazioni[dichiarazioni.length - 1]
    if (ultima) nomi.add(ultima[1])
  }
  return [...nomi]
}

/** Eventi che il main manda al renderer, direttamente o tramite un inoltro. */
const EMESSI = new Set<string>()
for (const { testo } of MAIN) {
  for (const c of canaliDi(testo, '\\.send')) EMESSI.add(c)
  for (const nome of inoltratori(testo)) {
    for (const c of canaliDi(testo, `\\b${nome}`)) EMESSI.add(c)
  }
}

const ordinati = (s: Iterable<string>): string[] => [...s].sort()

describe('Contratto IPC: estrazione dai sorgenti', () => {
  /**
   * Senza questa rete, una regex che smette di agganciare — per una virgola
   * nello stile, un `ipcMain` rinominato, un file spostato — renderebbe tutti
   * i controlli seguenti veri a vuoto, e la suite resterebbe verde mentre non
   * verifica piu' niente.
   */
  it('trova canali su entrambi i lati', () => {
    assert.ok(HANDLE.size > 0, 'nessun ipcMain.handle trovato in src/main/ipc.ts')
    assert.ok(ON.size > 0, 'nessun ipcMain.on trovato in src/main/ipc.ts')
    assert.ok(INVOKE.size > 0, 'nessun ipcRenderer.invoke trovato nel preload')
    assert.ok(SEND.size > 0, 'nessun ipcRenderer.send trovato nel preload')
    assert.ok(ASCOLTATI.size > 0, 'nessun ipcRenderer.on trovato nel preload')
    assert.ok(EMESSI.size > 0, 'nessun webContents.send trovato sotto src/main')
    assert.ok(MAIN.length > 5, `letti solo ${MAIN.length} sorgenti sotto src/main`)
  })

  it('non registra lo stesso canale sia con handle sia con on', () => {
    // Le due registrazioni convivrebbero senza errori, ma il canale
    // risponderebbe in un modo o nell'altro a seconda di chi chiama: un
    // comportamento che nessuno puo' dedurre leggendo il preload.
    const doppi = ordinati(HANDLE).filter((c) => ON.has(c))
    assert.deepEqual(doppi, [], `canali registrati due volte in modi diversi: ${doppi.join(', ')}`)
  })
})

describe('Contratto IPC: richieste dal renderer al main', () => {
  it('ogni canale invocato con invoke e gestito con handle', () => {
    const mancanti: string[] = []
    const accoppiatiMale: string[] = []

    for (const canale of ordinati(INVOKE)) {
      if (HANDLE.has(canale)) continue
      // `invoke` su un canale registrato con `on` non ricade su un errore
      // visibile: la promessa non si risolve mai e la parte di interfaccia che
      // l'aspetta resta a caricare all'infinito.
      if (ON.has(canale)) accoppiatiMale.push(canale)
      else mancanti.push(canale)
    }

    assert.deepEqual(
      accoppiatiMale,
      [],
      `invocati con invoke ma registrati con ipcMain.on (la promessa non si risolve mai): ${accoppiatiMale.join(', ')}`
    )
    assert.deepEqual(
      mancanti,
      [],
      `invocati dal preload ma non gestiti nel main (errore a runtime al primo uso): ${mancanti.join(', ')}`
    )
  })

  it('ogni canale usato con send e gestito con on', () => {
    const mancanti: string[] = []
    const accoppiatiMale: string[] = []

    for (const canale of ordinati(SEND)) {
      if (ON.has(canale)) continue
      // `send` verso un `ipcMain.handle` non arriva a nessuno e non solleva
      // niente: il comando dell'utente sparisce senza traccia.
      if (HANDLE.has(canale)) accoppiatiMale.push(canale)
      else mancanti.push(canale)
    }

    assert.deepEqual(
      accoppiatiMale,
      [],
      `mandati con send ma registrati con ipcMain.handle (il messaggio si perde): ${accoppiatiMale.join(', ')}`
    )
    assert.deepEqual(
      mancanti,
      [],
      `mandati dal preload ma non ascoltati nel main: ${mancanti.join(', ')}`
    )
  })
})

describe('Contratto IPC: eventi dal main al renderer', () => {
  it('ogni evento ascoltato dal preload viene emesso da qualche parte nel main', () => {
    const mai = ordinati(ASCOLTATI).filter((c) => !EMESSI.has(c))
    assert.deepEqual(
      mai,
      [],
      `il preload li ascolta ma nel main non li manda nessuno (l'interfaccia non si aggiorna mai): ${mai.join(', ')}`
    )
  })
})

/**
 * Canali gestiti nel main che nessuno invoca: non sono un difetto, possono
 * essere funzioni pronte ma non ancora collegate all'interfaccia. Restano qui
 * elencati nel nome del caso, cosi' compaiono nel resoconto di ogni esecuzione
 * senza far fallire niente.
 */
const ORFANI = ordinati([...HANDLE, ...ON]).filter((c) => !INVOKE.has(c) && !SEND.has(c))

describe('Contratto IPC: canali del main non usati dal preload', () => {
  it.skip(
    ORFANI.length === 0
      ? 'nessun canale del main resta inutilizzato'
      : `gestiti nel main ma mai usati dal preload: ${ORFANI.join(', ')}`,
    () => {}
  )
})
