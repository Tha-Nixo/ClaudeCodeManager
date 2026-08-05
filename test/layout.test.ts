import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EMPTY_LAYOUT,
  addPane,
  allPanes,
  collectLeaves,
  findPath,
  hasPane,
  isFloating,
  movePaneTo,
  nodeAt,
  removePane,
  setFocus,
  setRatio,
  swapPanes,
  toggleFloat,
  toggleZoom,
  updateFloating
} from '../src/renderer/src/compositor/layout'
import type { DropSide, Layout, LayoutNode, SplitDir } from '../src/renderer/src/compositor/layout'

/**
 * Invarianti dell'albero di layout.
 *
 * L'albero e' l'unica cosa che tiene insieme le sessioni aperte: se un id
 * compare due volte lo stesso terminale viene disegnato in due punti e i due
 * riquadri si contendono lo stesso PTY; se il fuoco punta a un riquadro che non
 * esiste piu' la tastiera smette di arrivare da qualche parte; se un ratio
 * diventa non finito i due figli dello split spariscono entrambi dallo schermo
 * (geometry.ts calcola le larghezze con Math.round(usable * ratio)).
 *
 * Nessuna di queste rotture da' errore: l'app resta viva e sbagliata. Per
 * questo si controlla la forma dell'albero dopo OGNI operazione, non solo alla
 * fine.
 */

/** Limiti documentati in layout.ts; non sono esportati, quindi si ripetono qui. */
const MIN_RATIO = 0.1
const MAX_RATIO = 0.9

/**
 * Controlla insieme tutti gli invarianti di un layout.
 * Lancia con un messaggio che dice quale operazione ha rotto cosa.
 */
function verificaAlbero(layout: Layout, contesto = ''): void {
  const dove = contesto ? ` [${contesto}]` : ''

  assert.ok(layout && typeof layout === 'object', `layout assente${dove}`)
  assert.ok(Array.isArray(layout.floating), `floating non e' un elenco${dove}`)

  const nelMosaico: string[] = []

  const visita = (nodo: LayoutNode | null | undefined, percorso: string): void => {
    assert.ok(nodo, `nodo nullo in '${percorso}'${dove}`)
    if (nodo.kind === 'leaf') {
      assert.equal(typeof nodo.id, 'string', `foglia senza id in '${percorso}'${dove}`)
      nelMosaico.push(nodo.id)
      return
    }
    assert.equal(nodo.kind, 'split', `tipo di nodo sconosciuto in '${percorso}'${dove}`)
    // Uno split monco e' il modo tipico in cui una rimozione sbagliata si
    // manifesta: meta' schermo resta vuota e i riquadri sotto sono irraggiungibili.
    assert.ok(nodo.a != null, `split senza figlio a in '${percorso}'${dove}`)
    assert.ok(nodo.b != null, `split senza figlio b in '${percorso}'${dove}`)
    assert.ok(
      Number.isFinite(nodo.ratio),
      `ratio non finito (${String(nodo.ratio)}) in '${percorso}'${dove}`
    )
    assert.ok(
      nodo.ratio >= MIN_RATIO && nodo.ratio <= MAX_RATIO,
      `ratio fuori dai limiti (${nodo.ratio}) in '${percorso}'${dove}`
    )
    visita(nodo.a, `${percorso}a`)
    visita(nodo.b, `${percorso}b`)
  }

  if (layout.root !== null) visita(layout.root, '')

  const flottanti = layout.floating.map((f) => f.id)
  const tutti = [...nelMosaico, ...flottanti]

  // Un id ripetuto significa due riquadri sullo stesso terminale.
  assert.equal(
    new Set(tutti).size,
    tutti.length,
    `id ripetuto fra ${JSON.stringify(tutti)}${dove}`
  )

  // Il fuoco deve essere raggiungibile, altrimenti la tastiera va nel vuoto.
  if (layout.focused !== null) {
    assert.ok(
      tutti.includes(layout.focused),
      `focused punta a '${layout.focused}' che non esiste${dove}`
    )
  }

  // Un ingrandimento fantasma nasconde tutti i riquadri e non ne mostra nessuno.
  if (layout.zoomed !== null) {
    assert.ok(
      tutti.includes(layout.zoomed),
      `zoomed punta a '${layout.zoomed}' che non esiste${dove}`
    )
  }

  // findPath e collectLeaves devono raccontare la stessa storia: il
  // trascinamento e il ridimensionamento si fidano dei percorsi.
  for (const id of nelMosaico) {
    const percorso = findPath(layout.root, id)
    assert.notEqual(percorso, null, `findPath non trova '${id}' che pero' e' nell'albero${dove}`)
    const nodo = nodeAt(layout.root, percorso as string)
    assert.deepEqual(nodo, { kind: 'leaf', id }, `il percorso di '${id}' porta altrove${dove}`)
  }

  for (const f of layout.floating) {
    for (const [campo, valore] of Object.entries({ x: f.x, y: f.y, w: f.w, h: f.h, z: f.z })) {
      assert.ok(
        Number.isFinite(valore),
        `flottante '${f.id}' con ${campo} non finito (${String(valore)})${dove}`
      )
    }
  }
}

const RETTANGOLO = { x: 100, y: 60, w: 800, h: 400 }

/** Costruisce un mosaico aggiungendo i riquadri uno dopo l'altro, come fa l'app. */
function costruisci(ids: string[], dir: SplitDir = 'h'): Layout {
  let layout: Layout = EMPTY_LAYOUT
  for (const id of ids) layout = addPane(layout, id, dir)
  return layout
}

const LATI: DropSide[] = ['left', 'right', 'top', 'bottom', 'center']

describe('layout: il controllo degli invarianti riconosce un albero rotto', () => {
  // Se verificaAlbero passasse su qualunque cosa, tutto il resto del file
  // sarebbe verde per finta.
  it('boccia un id ripetuto, uno split monco, un fuoco fantasma e un ratio NaN', () => {
    const dueVolteA: Layout = {
      root: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', id: 'a' }, b: { kind: 'leaf', id: 'a' } },
      floating: [],
      focused: 'a',
      zoomed: null
    }
    assert.throws(() => verificaAlbero(dueVolteA), /id ripetuto/)

    const monco = {
      root: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', id: 'a' }, b: null },
      floating: [],
      focused: 'a',
      zoomed: null
    } as unknown as Layout
    assert.throws(() => verificaAlbero(monco), /senza figlio b/)

    const fuocoFantasma: Layout = { root: { kind: 'leaf', id: 'a' }, floating: [], focused: 'b', zoomed: null }
    assert.throws(() => verificaAlbero(fuocoFantasma), /focused punta/)

    const ratioRotto = {
      root: { kind: 'split', dir: 'h', ratio: NaN, a: { kind: 'leaf', id: 'a' }, b: { kind: 'leaf', id: 'b' } },
      floating: [],
      focused: 'a',
      zoomed: null
    } as unknown as Layout
    assert.throws(() => verificaAlbero(ratioRotto), /ratio non finito/)

    // E un albero sano non deve dare falsi allarmi.
    verificaAlbero(costruisci(['a', 'b', 'c']))
  })
})

// --- Sequenza lunga e mista -------------------------------------------------

/** Generatore pseudocasuale con seme: la sequenza e' sempre la stessa. */
function generatore(seme: number): () => number {
  let s = seme >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Id che non esistono: ogni operazione deve ignorarli senza toccare niente. */
const ID_FANTASMA = ['fantasma', '', 'undefined', 'null', '../../altro', 'r999']
/**
 * Percorsi plausibili e percorsi spazzatura, come quelli che possono arrivare
 * da un trascinamento iniziato prima di una modifica dell'albero.
 */
const PERCORSI = ['', 'a', 'b', 'ab', 'ba', 'aaa', 'bbbb', 'zz', 'a b', '../..']
/** Compresi i valori che il trascinamento del canale produce fuori dai bordi. */
const RATIOS = [0, 0.05, 0.25, 0.5, 0.75, 1, 1.5, -3, Infinity, -Infinity]
const OPERAZIONI = [
  'addPane',
  'removePane',
  'setFocus',
  'setRatio',
  'swapPanes',
  'toggleFloat',
  'toggleZoom',
  'movePaneTo',
  'updateFloating'
] as const

interface Esito {
  cambi: Map<string, number>
  massimoRiquadri: number
}

function sequenzaMista(seme: number, passi: number, esito: Esito): void {
  const caso = generatore(seme)
  const scegli = <T,>(elenco: readonly T[]): T => elenco[Math.floor(caso() * elenco.length)]
  const numero = (max: number): number => Math.floor(caso() * max)

  let layout: Layout = EMPTY_LAYOUT
  let prossimo = 0

  for (let passo = 0; passo < passi; passo++) {
    const presenti = allPanes(layout)
    esito.massimoRiquadri = Math.max(esito.massimoRiquadri, presenti.length)

    // Un id noto quasi sempre, ogni tanto uno inventato.
    const bersaglio = (): string =>
      presenti.length > 0 && caso() < 0.85 ? scegli(presenti) : scegli(ID_FANTASMA)

    const op =
      presenti.length === 0 || caso() < 0.22 ? 'addPane' : scegli(OPERAZIONI.filter((o) => o !== 'addPane'))

    const precedente = layout
    const istantanea = structuredClone(precedente)
    let idUsati: string[] = []

    switch (op) {
      case 'addPane':
        layout = addPane(layout, `r${prossimo++}`, scegli(['h', 'v'] as SplitDir[]))
        break
      case 'removePane': {
        const id = bersaglio()
        idUsati = [id]
        layout = removePane(layout, id)
        break
      }
      case 'setFocus': {
        const id = bersaglio()
        idUsati = [id]
        layout = setFocus(layout, id)
        break
      }
      case 'setRatio':
        layout = setRatio(layout, scegli(PERCORSI), scegli(RATIOS))
        break
      case 'swapPanes': {
        const a = bersaglio()
        const b = bersaglio()
        idUsati = [a, b]
        layout = swapPanes(layout, a, b)
        break
      }
      case 'toggleFloat': {
        const id = bersaglio()
        idUsati = [id]
        layout = toggleFloat(layout, id, {
          x: numero(1200),
          y: numero(700),
          w: 200 + numero(600),
          h: 150 + numero(400)
        })
        break
      }
      case 'toggleZoom': {
        const id = bersaglio()
        idUsati = [id]
        layout = toggleZoom(layout, id)
        break
      }
      case 'movePaneTo': {
        const a = bersaglio()
        const b = bersaglio()
        idUsati = [a, b]
        layout = movePaneTo(layout, a, b, scegli(LATI))
        break
      }
      case 'updateFloating': {
        const id = bersaglio()
        idUsati = [id]
        layout = updateFloating(layout, id, { x: numero(1200), y: numero(700), z: numero(20) })
        break
      }
    }

    const dove = `seme ${seme}, passo ${passo}, ${op}(${idUsati.join(', ')})`
    verificaAlbero(layout, dove)

    // Le funzioni sono dichiarate pure e il layout finisce in layout.json e in
    // uno stato React: una modifica sul posto non farebbe ridisegnare niente.
    assert.deepEqual(precedente, istantanea, `${op} ha modificato il layout in ingresso [${dove}]`)

    // Un id che non esiste non deve poter cambiare niente: e' il caso di una
    // sessione chiusa mentre il menu contestuale era ancora aperto.
    if (idUsati.length > 0 && idUsati.some((id) => !hasPane(precedente, id))) {
      assert.deepEqual(layout, istantanea, `${op} su un id inesistente ha cambiato il layout [${dove}]`)
    }

    if (JSON.stringify(layout) !== JSON.stringify(istantanea)) {
      esito.cambi.set(op, (esito.cambi.get(op) ?? 0) + 1)
    }
  }

  // Chiusura a tappeto: alla fine non deve restare niente, e nessun passaggio
  // deve lanciare.
  let sicurezza = 0
  while (allPanes(layout).length > 0) {
    layout = removePane(layout, allPanes(layout)[0])
    verificaAlbero(layout, `seme ${seme}, chiusura ${sicurezza}`)
    assert.ok(sicurezza++ < 1000, 'removePane non riduce il numero di riquadri')
  }
  assert.equal(layout.root, null, `seme ${seme}: la radice non e' tornata nulla`)
  assert.equal(layout.focused, null, `seme ${seme}: fuoco su un riquadro chiuso`)
  assert.equal(layout.zoomed, null, `seme ${seme}: ingrandimento su un riquadro chiuso`)
  assert.deepEqual(layout.floating, [], `seme ${seme}: flottanti rimasti`)
}

describe('layout: sequenze lunghe e miste', () => {
  it('mantiene gli invarianti dopo ogni operazione, su piu semi', () => {
    const esito: Esito = { cambi: new Map(), massimoRiquadri: 0 }
    for (const seme of [1, 7, 12345, 987654321, 42]) sequenzaMista(seme, 400, esito)

    // La sequenza deve aver davvero fatto lavorare l'albero: senza questi due
    // controlli un cambio di pesi renderebbe il test verde senza provare nulla.
    assert.ok(esito.massimoRiquadri >= 6, `mosaico troppo piccolo: ${esito.massimoRiquadri} riquadri`)
    for (const op of OPERAZIONI) {
      assert.ok((esito.cambi.get(op) ?? 0) > 0, `l'operazione ${op} non ha mai cambiato niente`)
    }
  })
})

// --- Chiusura dell'ultimo riquadro ------------------------------------------

describe('layout: chiusura dei riquadri', () => {
  it('chiudere l ultimo riquadro lascia la radice nulla senza lanciare', () => {
    let layout = costruisci(['a'])
    layout = removePane(layout, 'a')
    verificaAlbero(layout, 'dopo l ultima chiusura')
    assert.equal(layout.root, null)
    assert.equal(layout.focused, null)
  })

  it('chiude i riquadri in ordine inverso e in ordine sparso senza lasciare split monchi', () => {
    for (const ordine of [
      ['a', 'b', 'c', 'd'],
      ['d', 'c', 'b', 'a'],
      ['b', 'd', 'a', 'c'],
      ['c', 'a', 'd', 'b']
    ]) {
      let layout = costruisci(['a', 'b', 'c', 'd'])
      for (const id of ordine) {
        layout = removePane(layout, id)
        verificaAlbero(layout, `chiusura ordine ${ordine.join('')} dopo ${id}`)
        assert.equal(hasPane(layout, id), false, `${id} risulta ancora aperto`)
      }
      assert.equal(layout.root, null, `ordine ${ordine.join('')}: radice non nulla`)
      assert.equal(layout.focused, null, `ordine ${ordine.join('')}: fuoco rimasto`)
    }
  })

  it('chiudere l ultimo riquadro del mosaico non tocca i flottanti', () => {
    let layout = costruisci(['a', 'b'])
    layout = toggleFloat(layout, 'b', RETTANGOLO)
    layout = removePane(layout, 'a')
    verificaAlbero(layout, 'mosaico vuoto ma flottante vivo')
    assert.equal(layout.root, null)
    // Il fuoco deve ricadere sull'unico riquadro rimasto, non finire nel vuoto.
    assert.equal(layout.focused, 'b')
    assert.equal(allPanes(layout).length, 1)
  })

  it('dopo aver chiuso tutto si puo ricominciare', () => {
    let layout = costruisci(['a', 'b'])
    layout = removePane(layout, 'a')
    layout = removePane(layout, 'b')
    layout = addPane(layout, 'c', 'h')
    verificaAlbero(layout, 'riapertura')
    assert.deepEqual(collectLeaves(layout.root), ['c'])
    assert.equal(layout.focused, 'c')
  })

  it('chiudere un riquadro ingrandito toglie anche l ingrandimento', () => {
    let layout = costruisci(['a', 'b'])
    layout = toggleZoom(layout, 'b')
    assert.equal(layout.zoomed, 'b')
    layout = removePane(layout, 'b')
    // Con zoomed su un riquadro chiuso lo stage resterebbe nero: geometry.ts
    // nasconde tutti i riquadri tranne quello ingrandito, che non c'e' piu'.
    verificaAlbero(layout, 'chiusura del riquadro ingrandito')
    assert.equal(layout.zoomed, null)
  })
})

// --- setRatio ---------------------------------------------------------------

describe('layout: setRatio ai limiti', () => {
  const conSplit = (): Layout => costruisci(['a', 'b'])

  it('tiene il rapporto dentro i limiti utilizzabili', () => {
    // Fuori da questi limiti uno dei due riquadri diventa una striscia inutile:
    // il trascinamento del canale oltre il bordo deve semplicemente fermarsi.
    for (const [dato, atteso] of [
      [0, MIN_RATIO],
      [-0.5, MIN_RATIO],
      [-1000, MIN_RATIO],
      [-Infinity, MIN_RATIO],
      [1, MAX_RATIO],
      [1.5, MAX_RATIO],
      [Infinity, MAX_RATIO],
      [0.42, 0.42]
    ] as [number, number][]) {
      const dopo = setRatio(conSplit(), '', dato)
      const radice = dopo.root as Extract<LayoutNode, { kind: 'split' }>
      assert.equal(radice.ratio, atteso, `setRatio(${dato}) ha dato ${radice.ratio}`)
      verificaAlbero(dopo, `setRatio(${dato})`)
    }
  })

  it('setRatio con NaN non deve far sparire i due riquadri', () => {
    // DIFETTO OSSERVATO: il clamp e' Math.min(0.9, Math.max(0.1, ratio)) e con
    // NaN restituisce NaN. Il ratio salvato diventa NaN, e geometry.ts calcola
    // Math.round(usable * NaN) => NaN: entrambi i figli dello split spariscono
    // dallo schermo, e il valore finisce cosi' anche in layout.json.
    const dopo = setRatio(conSplit(), '', NaN)
    const radice = dopo.root as Extract<LayoutNode, { kind: 'split' }>
    assert.ok(Number.isFinite(radice.ratio), `ratio diventato ${radice.ratio}`)
  })

  it('ignora i percorsi che non portano a uno split', () => {
    const solaFoglia = costruisci(['a'])
    assert.deepEqual(setRatio(solaFoglia, '', 0.3), solaFoglia)
    assert.deepEqual(setRatio(EMPTY_LAYOUT, '', 0.3), EMPTY_LAYOUT)

    const due = conSplit()
    // Percorso piu' profondo dell'albero: capita quando il trascinamento di un
    // canale continua dopo che il riquadro sotto e' stato chiuso.
    for (const percorso of ['a', 'b', 'aaa', 'bbbbbb']) {
      assert.deepEqual(setRatio(due, percorso, 0.3), due, `percorso '${percorso}'`)
    }
  })

  it('un percorso spazzatura non deve ridimensionare un altro split', () => {
    // DIFETTO OSSERVATO: nodeAt e replaceAt trattano ogni carattere diverso da
    // 'a' come se fosse 'b' (step === 'a' ? a : b). Un percorso mai emesso
    // dall'app, come 'z', viene quindi seguito fino al figlio b e ne cambia il
    // rapporto: la richiesta non viene respinta, ridimensiona un altro split.
    // Osservato: setRatio(layout, 'z', 0.3) porta a 0.3 il rapporto del nodo 'b'.
    const layout = costruisci(['a', 'b', 'c'])
    assert.deepEqual(setRatio(layout, 'z', 0.3), layout)
  })

  it('cambia solo lo split indicato', () => {
    const layout = costruisci(['a', 'b', 'c'])
    const dopo = setRatio(layout, 'b', 0.25)
    const radice = dopo.root as Extract<LayoutNode, { kind: 'split' }>
    assert.equal(radice.ratio, 0.5, 'lo split della radice non doveva muoversi')
    assert.equal((radice.b as Extract<LayoutNode, { kind: 'split' }>).ratio, 0.25)
    verificaAlbero(dopo, 'setRatio mirato')
  })
})

// --- movePaneTo -------------------------------------------------------------

describe('layout: movePaneTo (trascinamento)', () => {
  it('inserisce il riquadro dal lato giusto, e una volta sola', () => {
    // L'ordine delle foglie e' l'ordine sullo schermo: sbagliarlo significa
    // rilasciare a sinistra e vedere il riquadro comparire a destra.
    const casi: [DropSide, string[], SplitDir][] = [
      ['left', ['c', 'a', 'b'], 'h'],
      ['right', ['a', 'c', 'b'], 'h'],
      ['top', ['c', 'a', 'b'], 'v'],
      ['bottom', ['a', 'c', 'b'], 'v']
    ]
    for (const [lato, atteso, dir] of casi) {
      const dopo = movePaneTo(costruisci(['a', 'b', 'c']), 'c', 'a', lato)
      verificaAlbero(dopo, `movePaneTo ${lato}`)
      assert.deepEqual(collectLeaves(dopo.root), atteso, `lato ${lato}`)
      const nuovo = nodeAt(dopo.root, 'a') as Extract<LayoutNode, { kind: 'split' }>
      assert.equal(nuovo.kind, 'split', `lato ${lato}: nessuno split creato`)
      assert.equal(nuovo.dir, dir, `lato ${lato}: direzione sbagliata`)
      assert.equal(dopo.focused, 'c', `lato ${lato}: il fuoco deve seguire il riquadro trascinato`)
    }
  })

  it('al centro scambia i due riquadri senza duplicarli', () => {
    const dopo = movePaneTo(costruisci(['a', 'b', 'c']), 'a', 'c', 'center')
    verificaAlbero(dopo, 'movePaneTo center')
    assert.deepEqual(collectLeaves(dopo.root), ['c', 'b', 'a'])
    assert.equal(dopo.focused, 'a')
  })

  it('rilasciare un riquadro su se stesso non cambia niente', () => {
    const layout = costruisci(['a', 'b', 'c'])
    for (const lato of LATI) {
      assert.deepEqual(movePaneTo(layout, 'b', 'b', lato), layout, `lato ${lato}`)
    }
  })

  it('ignora gli id inesistenti da entrambe le parti', () => {
    const layout = costruisci(['a', 'b'])
    for (const lato of LATI) {
      assert.deepEqual(movePaneTo(layout, 'fantasma', 'a', lato), layout, `origine ignota, ${lato}`)
      assert.deepEqual(movePaneTo(layout, 'a', 'fantasma', lato), layout, `destinazione ignota, ${lato}`)
      assert.deepEqual(movePaneTo(layout, 'x', 'y', lato), layout, `entrambi ignoti, ${lato}`)
    }
  })

  it('con un solo riquadro non c e niente da trascinare', () => {
    const layout = costruisci(['a'])
    for (const lato of LATI) {
      assert.deepEqual(movePaneTo(layout, 'a', 'a', lato), layout, `lato ${lato}`)
      assert.deepEqual(movePaneTo(layout, 'a', 'b', lato), layout, `lato ${lato}, destinazione assente`)
      verificaAlbero(movePaneTo(layout, 'a', 'a', lato), `un solo riquadro, ${lato}`)
    }
  })

  it('trascinare l unico riquadro del mosaico su un flottante non lo fa sparire', () => {
    // Senza il controllo su detached.root il mosaico resterebbe vuoto e il
    // riquadro trascinato non finirebbe da nessuna parte: sessione persa.
    let layout = costruisci(['a', 'b'])
    layout = toggleFloat(layout, 'b', RETTANGOLO)
    const dopo = movePaneTo(layout, 'a', 'b', 'left')
    verificaAlbero(dopo, 'unico riquadro verso un flottante')
    assert.equal(hasPane(dopo, 'a'), true)
    assert.equal(hasPane(dopo, 'b'), true)
  })

  it('trascinare un flottante nel mosaico lo riaggancia una volta sola', () => {
    let layout = costruisci(['a', 'b', 'c'])
    layout = toggleFloat(layout, 'c', RETTANGOLO)
    const dopo = movePaneTo(layout, 'c', 'a', 'right')
    verificaAlbero(dopo, 'flottante riagganciato per trascinamento')
    assert.equal(isFloating(dopo, 'c'), false)
    assert.deepEqual(dopo.floating, [])
    assert.deepEqual(collectLeaves(dopo.root), ['a', 'c', 'b'])
    assert.equal(dopo.focused, 'c')
  })

  it('lo scambio al centro non vale per i flottanti', () => {
    // Un flottante non occupa una posizione nell'albero: scambiarlo lo
    // duplicherebbe o lo farebbe sparire.
    let layout = costruisci(['a', 'b'])
    layout = toggleFloat(layout, 'b', RETTANGOLO)
    assert.deepEqual(movePaneTo(layout, 'b', 'a', 'center'), layout)
    assert.deepEqual(movePaneTo(layout, 'a', 'b', 'center'), layout)
  })

  it('trascinamenti ripetuti non moltiplicano ne perdono riquadri', () => {
    let layout = costruisci(['a', 'b', 'c', 'd'])
    const attesi = ['a', 'b', 'c', 'd']
    let i = 0
    for (const origine of attesi) {
      for (const destinazione of attesi) {
        const lato = LATI[i++ % LATI.length]
        layout = movePaneTo(layout, origine, destinazione, lato)
        verificaAlbero(layout, `${origine} -> ${destinazione} (${lato})`)
        assert.deepEqual([...allPanes(layout)].sort(), attesi, `dopo ${origine} -> ${destinazione}`)
      }
    }
  })
})

// --- Flottanti --------------------------------------------------------------

describe('layout: flottanti', () => {
  it('sganciare e riagganciare molte volte non altera l insieme dei riquadri', () => {
    let layout = costruisci(['a', 'b', 'c'])
    const attesi = ['a', 'b', 'c']

    for (let giro = 0; giro < 40; giro++) {
      layout = toggleFloat(layout, 'c', RETTANGOLO)
      verificaAlbero(layout, `giro ${giro}, sganciato`)
      assert.equal(isFloating(layout, 'c'), true, `giro ${giro}: doveva essere flottante`)
      assert.equal(layout.focused, 'c')
      assert.deepEqual([...allPanes(layout)].sort(), attesi, `giro ${giro}, sganciato`)

      layout = toggleFloat(layout, 'c', RETTANGOLO)
      verificaAlbero(layout, `giro ${giro}, riagganciato`)
      assert.equal(isFloating(layout, 'c'), false, `giro ${giro}: doveva tornare nel mosaico`)
      assert.equal(layout.focused, 'c')
      assert.deepEqual([...allPanes(layout)].sort(), attesi, `giro ${giro}, riagganciato`)
    }
  })

  it('sganciare l unico riquadro svuota il mosaico ma non perde la sessione', () => {
    let layout = costruisci(['a'])
    layout = toggleFloat(layout, 'a', RETTANGOLO)
    verificaAlbero(layout, 'unico riquadro sganciato')
    assert.equal(layout.root, null)
    assert.deepEqual(allPanes(layout), ['a'])
    assert.equal(layout.focused, 'a')

    layout = toggleFloat(layout, 'a', RETTANGOLO)
    verificaAlbero(layout, 'unico riquadro riagganciato')
    assert.deepEqual(collectLeaves(layout.root), ['a'])
    assert.deepEqual(layout.floating, [])
  })

  it('il flottante che riceve il fuoco passa davanti agli altri', () => {
    let layout = costruisci(['a', 'b', 'c'])
    layout = toggleFloat(layout, 'b', RETTANGOLO)
    layout = toggleFloat(layout, 'c', RETTANGOLO)

    const z = (l: Layout, id: string): number => l.floating.find((f) => f.id === id)!.z
    assert.ok(z(layout, 'c') > z(layout, 'b'), 'l ultimo sganciato deve stare sopra')

    layout = setFocus(layout, 'b')
    verificaAlbero(layout, 'fuoco su un flottante')
    // Senza il rialzo il riquadro attivo resterebbe coperto e si scriverebbe
    // alla cieca in un terminale non visibile.
    assert.ok(z(layout, 'b') > z(layout, 'c'), 'il flottante attivo deve venire in primo piano')
  })

  it('sganciare un riquadro ingrandito toglie l ingrandimento', () => {
    let layout = costruisci(['a', 'b'])
    layout = toggleZoom(layout, 'a')
    layout = toggleFloat(layout, 'a', RETTANGOLO)
    verificaAlbero(layout, 'sganciato mentre era ingrandito')
    assert.equal(layout.zoomed, null)
  })

  it('updateFloating tocca solo il riquadro indicato e ignora gli sconosciuti', () => {
    let layout = costruisci(['a', 'b'])
    layout = toggleFloat(layout, 'a', RETTANGOLO)
    layout = toggleFloat(layout, 'b', RETTANGOLO)

    const spostato = updateFloating(layout, 'a', { x: 12, y: 34 })
    verificaAlbero(spostato, 'updateFloating')
    assert.deepEqual(
      spostato.floating.find((f) => f.id === 'a'),
      { ...layout.floating.find((f) => f.id === 'a')!, x: 12, y: 34 }
    )
    assert.deepEqual(spostato.floating.find((f) => f.id === 'b'), layout.floating.find((f) => f.id === 'b'))
    assert.deepEqual(updateFloating(layout, 'fantasma', { x: 1 }), layout)
  })
})

// --- Fuoco e ingrandimento --------------------------------------------------

describe('layout: fuoco e ingrandimento', () => {
  it('il fuoco non si sposta mai su un riquadro che non esiste', () => {
    const layout = costruisci(['a', 'b'])
    for (const id of ['fantasma', '', 'A', 'aa']) {
      const dopo = setFocus(layout, id)
      assert.deepEqual(dopo, layout, `setFocus('${id}')`)
      verificaAlbero(dopo, `setFocus('${id}')`)
    }
  })

  it('chiudendo il riquadro attivo il fuoco passa a uno che esiste', () => {
    let layout = costruisci(['a', 'b', 'c'])
    layout = setFocus(layout, 'b')
    layout = removePane(layout, 'b')
    verificaAlbero(layout, 'chiusura del riquadro attivo')
    assert.notEqual(layout.focused, null)
    assert.equal(hasPane(layout, layout.focused as string), true)
  })

  it('chiudendo un riquadro qualsiasi il fuoco resta dov era', () => {
    let layout = costruisci(['a', 'b', 'c'])
    layout = setFocus(layout, 'a')
    layout = removePane(layout, 'c')
    assert.equal(layout.focused, 'a')
    verificaAlbero(layout, 'chiusura di un riquadro non attivo')
  })

  it('toggleZoom ignora gli sconosciuti e si spegne al secondo colpo', () => {
    const layout = costruisci(['a', 'b'])
    assert.deepEqual(toggleZoom(layout, 'fantasma'), layout)
    const acceso = toggleZoom(layout, 'a')
    assert.equal(acceso.zoomed, 'a')
    assert.equal(toggleZoom(acceso, 'a').zoomed, null)
    // Ingrandire un altro riquadro sostituisce l'ingrandimento, non ne aggiunge.
    assert.equal(toggleZoom(acceso, 'b').zoomed, 'b')
  })
})

// --- swapPanes --------------------------------------------------------------

describe('layout: swapPanes', () => {
  it('scambia le posizioni senza toccare l insieme dei riquadri', () => {
    const layout = costruisci(['a', 'b', 'c'])
    const dopo = swapPanes(layout, 'a', 'c')
    verificaAlbero(dopo, 'swapPanes')
    assert.deepEqual(collectLeaves(dopo.root), ['c', 'b', 'a'])
    // Due scambi riportano allo stato di partenza: la posizione e' l'unica cosa
    // che cambia.
    assert.deepEqual(swapPanes(dopo, 'a', 'c'), layout)
  })

  it('non fa niente con se stesso, con gli sconosciuti o con un flottante', () => {
    let layout = costruisci(['a', 'b', 'c'])
    assert.deepEqual(swapPanes(layout, 'a', 'a'), layout)
    assert.deepEqual(swapPanes(layout, 'a', 'fantasma'), layout)
    assert.deepEqual(swapPanes(layout, 'fantasma', 'a'), layout)
    layout = toggleFloat(layout, 'c', RETTANGOLO)
    assert.deepEqual(swapPanes(layout, 'a', 'c'), layout)
  })
})

// --- EMPTY_LAYOUT -----------------------------------------------------------

describe('layout: operazioni sul layout vuoto', () => {
  const VUOTO = { root: null, floating: [], focused: null, zoomed: null }

  it('nessuna operazione lancia o inventa riquadri', () => {
    const risultati: Layout[] = [
      removePane(EMPTY_LAYOUT, 'a'),
      setFocus(EMPTY_LAYOUT, 'a'),
      setRatio(EMPTY_LAYOUT, '', 0.5),
      setRatio(EMPTY_LAYOUT, 'ab', NaN),
      swapPanes(EMPTY_LAYOUT, 'a', 'b'),
      toggleFloat(EMPTY_LAYOUT, 'a', RETTANGOLO),
      toggleZoom(EMPTY_LAYOUT, 'a'),
      updateFloating(EMPTY_LAYOUT, 'a', { x: 1 })
    ]
    for (const lato of LATI) risultati.push(movePaneTo(EMPTY_LAYOUT, 'a', 'b', lato))

    for (const [i, r] of risultati.entries()) {
      verificaAlbero(r, `layout vuoto, risultato ${i}`)
      assert.deepEqual(r, VUOTO, `risultato ${i}`)
      assert.deepEqual(allPanes(r), [], `risultato ${i}`)
    }
  })

  it('il primo riquadro diventa la radice ed e attivo', () => {
    const dopo = addPane(EMPTY_LAYOUT, 'a', 'h')
    verificaAlbero(dopo, 'primo riquadro')
    assert.deepEqual(dopo.root, { kind: 'leaf', id: 'a' })
    assert.equal(dopo.focused, 'a')
  })

  it('EMPTY_LAYOUT resta vuoto: e condiviso da tutte le finestre', () => {
    // E' una costante esportata: se una funzione la modificasse sul posto, ogni
    // avvio successivo partirebbe con i riquadri della sessione precedente.
    assert.deepEqual(EMPTY_LAYOUT, VUOTO)
  })
})
