import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateTheme, type Theme } from '../src/shared/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '../src/shared/themes/builtin'

/**
 * Un tema e' l'unica cosa che l'utente vede prima ancora di leggere qualsiasi
 * testo dell'app: se la validazione lascia passare un tema mezzo rotto, il
 * risultato non e' un errore ma una finestra illeggibile. Da qui l'insistenza
 * sul fatto che ogni rifiuto nomini il campo colpevole: il tema arriva da un
 * file JSON scritto a mano, e "non valido" senza altro non aiuta a correggerlo.
 */

type Grezzo = Record<string, unknown>

/**
 * Punto di partenza dei casi negativi: una copia profonda di un tema integrato,
 * cioe' un oggetto che sicuramente passa la validazione. Mutando un solo campo
 * si e' certi che il rifiuto arrivi da quel campo e non da un altro difetto
 * gia' presente nel materiale di partenza.
 */
function clonaTema(id = 'claude-light'): Grezzo {
  const base = BUILTIN_THEMES.find((t) => t.id === id)
  assert.ok(base, `tema integrato mancante: ${id}`)
  return JSON.parse(JSON.stringify(base)) as Grezzo
}

function ui(tema: Grezzo): Grezzo {
  return tema.ui as Grezzo
}

function terminal(tema: Grezzo): Grezzo {
  return tema.terminal as Grezzo
}

function assertAccettato(raw: unknown, contesto: string): Theme {
  const { theme, error } = validateTheme(raw)
  assert.equal(error, null, `${contesto}: rifiutato con "${error}"`)
  assert.ok(theme, `${contesto}: accettato ma senza tema`)
  return theme
}

/**
 * Un rifiuto vale solo se dice all'utente dove guardare: si controlla sia che
 * il tema non venga applicato, sia che il messaggio nomini il campo.
 */
function assertRifiutato(raw: unknown, campo: RegExp, contesto: string): string {
  const { theme, error } = validateTheme(raw)
  assert.equal(theme, null, `${contesto}: accettato invece che rifiutato`)
  assert.ok(typeof error === 'string' && error.length > 0, `${contesto}: rifiutato senza messaggio`)
  assert.match(error, campo, `${contesto}: il messaggio non dice quale campo e' il problema`)
  return error
}

const UI_KEYS = [
  'desktop',
  'panel',
  'panelRaised',
  'borderIdle',
  'borderFocus',
  'text',
  'textDim',
  'accent',
  'ok',
  'waiting',
  'error'
] as const

const TERM_KEYS = ['background', 'foreground', 'cursor', 'selection'] as const

/** Valori che nessun campo colore deve accettare, comunque siano scritti. */
const NON_COLORI = [
  'rosso',
  '#GGG',
  '#12345',
  'rgb(1,2,3)',
  '#1234567',
  'FFFFFF',
  '#',
  '',
  '  #ffffff  ',
  null,
  123,
  true,
  ['#ffffff'],
  { hex: '#ffffff' }
]

describe('Regressione della issue #15: dark deve essere un booleano vero', () => {
  /**
   * Il caso reale: `"dark": "false"` con le virgolette di troppo. La stringa
   * non e' uguale al booleano false, quindi il tema chiaro veniva applicato
   * come scuro — ombre nere su fondo chiaro, barre di scorrimento invertite —
   * senza nessun avviso. Si parte da claude-light perche' e' l'unico tema
   * integrato con dark: false: e' esattamente lo scenario che si rompeva.
   */
  it('il tema di partenza e chiaro e valido, altrimenti il caso non proverebbe niente', () => {
    const tema = assertAccettato(clonaTema('claude-light'), 'claude-light clonato')
    assert.equal(tema.dark, false, 'il tema di partenza deve essere chiaro')
  })

  it('rifiuta "false" fra virgolette nominando il campo dark', () => {
    const tema = clonaTema('claude-light')
    tema.dark = 'false'
    const errore = assertRifiutato(tema, /dark/, 'dark = "false"')
    // Il messaggio deve far capire che il problema sono le virgolette, non il
    // valore: chi ha scritto il file vede "false" e lo crede giusto.
    assert.match(errore, /dark/)
  })

  it('rifiuta "true" fra virgolette, che sarebbe passato per caso', () => {
    const tema = clonaTema('claude-dark')
    tema.dark = 'true'
    assertRifiutato(tema, /dark/, 'dark = "true"')
  })

  it('rifiuta qualsiasi altro tipo al posto del booleano', () => {
    for (const valore of [0, 1, null, [], {}, 'si', 'no', 'sì', 'yes']) {
      const tema = clonaTema('claude-light')
      tema.dark = valore
      assertRifiutato(tema, /dark/, `dark = ${JSON.stringify(valore)}`)
    }
  })

  it('true e false veri continuano a funzionare e arrivano intatti', () => {
    const scuro = clonaTema('claude-light')
    scuro.dark = true
    assert.equal(assertAccettato(scuro, 'dark = true').dark, true)

    const chiaro = clonaTema('claude-dark')
    chiaro.dark = false
    assert.equal(assertAccettato(chiaro, 'dark = false').dark, false)
  })

  it('un tema senza dark vale come scuro: e il ripiego, non un rifiuto', () => {
    // dark e' l'unico campo facoltativo. Chi omette il campo ottiene un tema
    // scuro, che e' il caso di gran lunga piu' comune; chi lo scrive male
    // ottiene un errore invece di un risultato a sorpresa.
    const tema = clonaTema('claude-light')
    delete tema.dark
    assert.equal(assertAccettato(tema, 'dark assente').dark, true)
  })
})

describe('temi integrati: invarianti', () => {
  it('ogni tema integrato passa la stessa validazione dei temi personali', () => {
    // Se un tema integrato non passasse, l'app spedirebbe un tema che rifiuta
    // di caricare quando l'utente lo copia per personalizzarlo.
    for (const tema of BUILTIN_THEMES) {
      const { theme, error } = validateTheme(tema)
      assert.equal(error, null, `tema integrato "${tema.id}" rifiutato: ${error}`)
      assert.ok(theme, `tema integrato "${tema.id}" senza risultato`)
    }
  })

  it('ogni tema ha esattamente 16 colori ansi, tutti esadecimali a 6 cifre', () => {
    for (const tema of BUILTIN_THEMES) {
      const ansi = tema.terminal.ansi
      assert.ok(Array.isArray(ansi), `${tema.id}: ansi non e' un elenco`)
      assert.equal(ansi.length, 16, `${tema.id}: ansi ha ${ansi.length} voci invece di 16`)
      ansi.forEach((colore, i) => {
        // Forma piena e opaca: le 16 caselle finiscono in xterm, dove un colore
        // con canale alfa o abbreviato produce rese diverse fra le piattaforme.
        assert.match(colore, /^#[0-9a-fA-F]{6}$/, `${tema.id}: ansi[${i}] = ${JSON.stringify(colore)}`)
      })
    }
  })

  it('i 16 colori ansi sono tutti diversi fra loro', () => {
    // Due caselle identiche per copia-incolla rendono indistinguibili due tipi
    // di output nel terminale (per esempio errori e avvisi).
    for (const tema of BUILTIN_THEMES) {
      const visti = new Map<string, number>()
      tema.terminal.ansi.forEach((colore, i) => {
        const chiave = colore.toLowerCase()
        const primo = visti.get(chiave)
        assert.equal(primo, undefined, `${tema.id}: ansi[${i}] ripete ansi[${primo}] (${colore})`)
        visti.set(chiave, i)
      })
    }
  })

  it('tutti i colori di ui e terminal sono esadecimali', () => {
    for (const tema of BUILTIN_THEMES) {
      for (const key of UI_KEYS) {
        assert.match(tema.ui[key], /^#[0-9a-fA-F]{3,8}$/, `${tema.id}: ui.${key}`)
      }
      for (const key of TERM_KEYS) {
        assert.match(tema.terminal[key], /^#[0-9a-fA-F]{3,8}$/, `${tema.id}: terminal.${key}`)
      }
    }
  })

  it('gli identificatori sono unici: sono la chiave salvata nella configurazione', () => {
    const visti = new Set<string>()
    for (const tema of BUILTIN_THEMES) {
      assert.ok(!visti.has(tema.id), `identificatore duplicato: ${tema.id}`)
      visti.add(tema.id)
    }
  })

  it('ogni tema ha un nome leggibile e un dark booleano', () => {
    for (const tema of BUILTIN_THEMES) {
      assert.ok(tema.name.trim().length > 0, `${tema.id}: nome vuoto`)
      assert.equal(typeof tema.dark, 'boolean', `${tema.id}: dark non e' un booleano`)
    }
  })

  it('nessun tema integrato si dichiara personale', () => {
    // custom distingue nella UI i temi caricati da file: un integrato marcato
    // custom comparirebbe nella sezione sbagliata delle impostazioni.
    for (const tema of BUILTIN_THEMES) {
      assert.ok(!tema.custom, `${tema.id}: marcato come personale`)
      assert.equal(tema.source, undefined, `${tema.id}: ha un file di origine`)
    }
  })

  it('il tema predefinito esiste davvero fra gli integrati', () => {
    // Se puntasse a un identificatore inesistente l'app partirebbe senza tema.
    assert.ok(
      BUILTIN_THEMES.some((t) => t.id === DEFAULT_THEME_ID),
      `DEFAULT_THEME_ID "${DEFAULT_THEME_ID}" non corrisponde a nessun tema`
    )
  })

  it('esiste almeno un tema chiaro e almeno uno scuro', () => {
    assert.ok(BUILTIN_THEMES.some((t) => t.dark === false), 'nessun tema chiaro')
    assert.ok(BUILTIN_THEMES.some((t) => t.dark === true), 'nessun tema scuro')
  })
})

describe('validateTheme: cose che non sono un tema', () => {
  it('rifiuta i valori che non sono oggetti', () => {
    for (const valore of [null, undefined, '', 'claude-dark', 42, 0, true, false]) {
      const { theme, error } = validateTheme(valore)
      assert.equal(theme, null, `${JSON.stringify(valore)} accettato come tema`)
      assert.match(error ?? '', /oggetto/, `${JSON.stringify(valore)}: messaggio poco chiaro`)
    }
  })

  it('rifiuta un oggetto vuoto dicendo qual e il primo campo mancante', () => {
    assertRifiutato({}, /id/, 'oggetto vuoto')
  })

  it('rifiuta un elenco al posto di un oggetto', () => {
    // Un file che contiene `[ {...} ]` invece del tema e' un errore frequente:
    // non deve essere scambiato per un tema con campi mancanti silenziosi.
    assertRifiutato([], /id|oggetto/, 'elenco vuoto')
    assertRifiutato([clonaTema()], /id|oggetto/, 'elenco con dentro un tema')
  })
})

describe('validateTheme: campi mancanti, uno alla volta', () => {
  it('senza id, o con un id malformato, lo dice', () => {
    for (const valore of [undefined, '', 'Claude Dark', '-inizia', 'con spazio', 'CIAO', 'à', 42, null]) {
      const tema = clonaTema()
      if (valore === undefined) delete tema.id
      else tema.id = valore
      assertRifiutato(tema, /id/, `id = ${JSON.stringify(valore)}`)
    }
  })

  it('senza name, o con un name di soli spazi, lo dice', () => {
    for (const valore of [undefined, '', '   ', '\t\n', 42, null, {}]) {
      const tema = clonaTema()
      if (valore === undefined) delete tema.name
      else tema.name = valore
      assertRifiutato(tema, /name/, `name = ${JSON.stringify(valore)}`)
    }
  })

  it('senza la sezione ui lo dice, senza attribuirlo a un colore', () => {
    for (const valore of [undefined, null, 'chiaro', 42, true]) {
      const tema = clonaTema()
      if (valore === undefined) delete tema.ui
      else tema.ui = valore
      assertRifiutato(tema, /ui/, `ui = ${JSON.stringify(valore)}`)
    }
  })

  it('senza la sezione terminal lo dice', () => {
    for (const valore of [undefined, null, 'scuro', 42, true]) {
      const tema = clonaTema()
      if (valore === undefined) delete tema.terminal
      else tema.terminal = valore
      assertRifiutato(tema, /terminal/, `terminal = ${JSON.stringify(valore)}`)
    }
  })

  it('nomina la singola chiave di ui che manca', () => {
    for (const key of UI_KEYS) {
      const tema = clonaTema()
      delete ui(tema)[key]
      const errore = assertRifiutato(tema, new RegExp(`ui\\.${key}\\b`), `ui.${key} mancante`)
      // Nominare la sezione non basta: il file ha undici colori nella ui.
      assert.ok(errore.includes(key), `il messaggio "${errore}" non nomina ${key}`)
    }
  })

  it('nomina la singola chiave di terminal che manca', () => {
    for (const key of TERM_KEYS) {
      const tema = clonaTema()
      delete terminal(tema)[key]
      assertRifiutato(tema, new RegExp(`terminal\\.${key}\\b`), `terminal.${key} mancante`)
    }
  })

  it('rifiuta un terminal senza ansi', () => {
    const tema = clonaTema()
    delete terminal(tema).ansi
    assertRifiutato(tema, /ansi/, 'ansi mancante')
  })
})

describe('validateTheme: colori', () => {
  it('rifiuta i valori che non sono colori esadecimali, in ogni campo di ui', () => {
    for (const valore of NON_COLORI) {
      const tema = clonaTema()
      ui(tema).text = valore
      assertRifiutato(tema, /ui\.text\b/, `ui.text = ${JSON.stringify(valore)}`)
    }
  })

  it('rifiuta i valori che non sono colori esadecimali nel terminale', () => {
    for (const valore of NON_COLORI) {
      const tema = clonaTema()
      terminal(tema).background = valore
      assertRifiutato(tema, /terminal\.background\b/, `terminal.background = ${JSON.stringify(valore)}`)
    }
  })

  it('rifiuta un colore non valido anche se e nascosto in fondo ad ansi', () => {
    // Il quindicesimo colore si nota solo quando un programma lo usa: se
    // passasse, il difetto si manifesterebbe giorni dopo il caricamento.
    for (const valore of NON_COLORI) {
      const tema = clonaTema()
      const ansi = terminal(tema).ansi as unknown[]
      ansi[15] = valore
      assertRifiutato(tema, /ansi/, `ansi[15] = ${JSON.stringify(valore)}`)
    }
  })

  it('accetta le tre forme esadecimali legittime', () => {
    for (const colore of ['#abc', '#ABC', '#aabbcc', '#AABBCC', '#aabbccdd']) {
      const tema = clonaTema()
      ui(tema).text = colore
      const risultato = assertAccettato(tema, `ui.text = ${colore}`)
      assert.equal(risultato.ui.text, colore, 'il colore non deve essere riscritto')
    }
  })
})

describe('validateTheme: la tavolozza ansi deve avere esattamente 16 voci', () => {
  it('rifiuta un elenco piu corto', () => {
    for (const n of [0, 1, 8, 15]) {
      const tema = clonaTema()
      const ansi = terminal(tema).ansi as string[]
      terminal(tema).ansi = ansi.slice(0, n)
      assertRifiutato(tema, /ansi/, `ansi con ${n} voci`)
    }
  })

  it('rifiuta un elenco piu lungo', () => {
    // Con 17 voci le ultime verrebbero ignorate in silenzio: chi ha aggiunto
    // un colore in mezzo si ritroverebbe tutta la tavolozza sfasata di uno.
    for (const n of [17, 20, 32]) {
      const tema = clonaTema()
      const ansi = terminal(tema).ansi as string[]
      terminal(tema).ansi = [...ansi, ...Array(n - 16).fill('#ffffff')]
      assertRifiutato(tema, /ansi/, `ansi con ${n} voci`)
    }
  })

  it('rifiuta un ansi che non e un elenco', () => {
    for (const valore of [null, '#ffffff', 16, {}, { 0: '#ffffff' }, true]) {
      const tema = clonaTema()
      terminal(tema).ansi = valore
      assertRifiutato(tema, /ansi/, `ansi = ${JSON.stringify(valore)}`)
    }
  })

  it('rifiuta un ansi in cui una voce e null', () => {
    // Questo e' il caso che il JSON puo' davvero produrre: `null` in mezzo
    // all'elenco, per esempio dopo aver cancellato un colore a meta'.
    const tema = clonaTema()
    const ansi = terminal(tema).ansi as unknown[]
    ansi[7] = null
    assertRifiutato(tema, /ansi/, 'ansi con la settima voce a null')
  })

  /**
   * DIFETTO NUOVO, non corretto: un elenco ansi con un buco (voce mai
   * assegnata) viene ACCETTATO. Il controllo usa `term.ansi.every(isColor)`, e
   * `every` salta le posizioni vuote invece di visitarle: la lunghezza resta 16
   * e la validazione passa, restituendo un tema con `terminal.ansi[7] ===
   * undefined`. Osservato con `delete ansi[7]` su una copia di claude-light:
   * error === null e theme.terminal.ansi[7] === undefined.
   *
   * Oggi non e' raggiungibile dall'utente, perche' l'unico chiamante
   * (src/main/theme/store.ts) passa il risultato di JSON.parse, che non produce
   * mai elenchi con buchi. Resta una trappola per il prossimo chiamante: basta
   * un tema costruito in memoria perche' xterm riceva un colore undefined.
   */
  it('rifiuta un ansi con un buco in mezzo (oggi lo accetta)', () => {
    const tema = clonaTema()
    const ansi = terminal(tema).ansi as unknown[]
    delete ansi[7]
    assertRifiutato(tema, /ansi/, 'ansi con la settima voce assente')
  })

  it('accetta esattamente 16 colori validi', () => {
    const tema = clonaTema()
    terminal(tema).ansi = Array(16).fill('#123456')
    const risultato = assertAccettato(tema, 'ansi con 16 colori')
    assert.equal(risultato.terminal.ansi.length, 16)
  })
})

describe('validateTheme: cosa restituisce quando accetta', () => {
  it('senza file di origine il tema non e personale', () => {
    const risultato = assertAccettato(clonaTema(), 'senza source')
    assert.equal(risultato.custom, false, 'un tema senza file non va nella sezione dei personali')
    assert.equal(risultato.source, undefined)
  })

  it('con un file di origine conserva il percorso da mostrare in caso di errore', () => {
    const { theme, error } = validateTheme(clonaTema(), 'C:\\temi\\mio.json')
    assert.equal(error, null)
    assert.ok(theme)
    assert.equal(theme.custom, true)
    assert.equal(theme.source, 'C:\\temi\\mio.json')
  })

  it('ripulisce il nome dagli spazi ai bordi', () => {
    // Il nome finisce in un elenco allineato: gli spazi si vedrebbero.
    const tema = clonaTema()
    tema.name = '  Mio tema  '
    assert.equal(assertAccettato(tema, 'nome con spazi').name, 'Mio tema')
  })

  it('ignora una description del tipo sbagliato invece di rifiutare il tema', () => {
    // La descrizione e' decorativa: perdere un tema intero per colpa sua
    // sarebbe una punizione sproporzionata.
    for (const valore of [42, null, {}, ['ciao']]) {
      const tema = clonaTema()
      tema.description = valore
      assert.equal(
        assertAccettato(tema, `description = ${JSON.stringify(valore)}`).description,
        undefined
      )
    }
  })

  it('conserva la description quando e una stringa', () => {
    const tema = clonaTema()
    tema.description = 'la mia palette'
    assert.equal(assertAccettato(tema, 'description valida').description, 'la mia palette')
  })

  it('non inventa campi: id, colori e tavolozza arrivano identici', () => {
    const partenza = clonaTema('gruvbox')
    const risultato = assertAccettato(partenza, 'gruvbox clonato')
    assert.equal(risultato.id, 'gruvbox')
    assert.deepEqual(risultato.ui, partenza.ui)
    assert.deepEqual(risultato.terminal, partenza.terminal)
  })
})

/**
 * Leggibilita'.
 *
 * Il rapporto di contrasto WCAG 2.1: (L1 + 0.05) / (L2 + 0.05) sulle luminanze
 * relative. La soglia AA per il testo normale e' 4.5:1. Sotto quel valore il
 * testo resta visibile ma smette di essere comodo, e su un pannello che si
 * legge tutto il giorno la differenza si sente.
 */
function luminanzaCanale(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminanza(hex: string): number {
  let h = hex.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * luminanzaCanale(r) + 0.7152 * luminanzaCanale(g) + 0.0722 * luminanzaCanale(b)
}

function contrasto(a: string, b: string): number {
  const la = luminanza(a)
  const lb = luminanza(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('leggibilita: contrasto fra testo e sfondo', () => {
  it('la formula del contrasto e quella di WCAG', () => {
    // Senza questa verifica i numeri riportati piu' sotto non varrebbero nulla.
    assert.equal(Number(contrasto('#000000', '#ffffff').toFixed(2)), 21)
    assert.equal(Number(contrasto('#ffffff', '#000000').toFixed(2)), 21)
    assert.equal(contrasto('#123456', '#123456'), 1)
    assert.equal(Number(contrasto('#777777', '#ffffff').toFixed(2)), 4.48)
    // La forma abbreviata deve dare lo stesso risultato di quella estesa.
    assert.equal(contrasto('#fff', '#000000'), contrasto('#ffffff', '#000000'))
  })

  it('il testo principale supera 4.5:1 su ogni sfondo del tema', () => {
    for (const tema of BUILTIN_THEMES) {
      for (const sfondo of ['desktop', 'panel', 'panelRaised'] as const) {
        const r = contrasto(tema.ui.text, tema.ui[sfondo])
        assert.ok(
          r >= 4.5,
          `${tema.id}: ui.text su ui.${sfondo} e' ${r.toFixed(2)}:1, sotto la soglia AA di 4.5:1`
        )
      }
      const term = contrasto(tema.terminal.foreground, tema.terminal.background)
      assert.ok(
        term >= 4.5,
        `${tema.id}: terminale ${term.toFixed(2)}:1, sotto la soglia AA di 4.5:1`
      )
    }
  })

  /**
   * DIFETTO NUOVO, non corretto: il testo attenuato (ui.textDim) sta sotto
   * 4.5:1 in cinque temi integrati su sei. Misurato sul contenuto attuale di
   * src/shared/themes/builtin.ts, rapporto textDim su panel / desktop /
   * panelRaised:
   *
   *   claude-dark     4.44  4.88  4.03
   *   claude-light    4.89  4.43  4.20
   *   mezzanotte      3.46  3.81  3.04
   *   gruvbox         4.02  4.47  3.58
   *   nord            3.28  4.07  2.81
   *   alto-contrasto  9.27 10.02  8.30
   *
   * textDim non e' decorativo: ci finiscono percorsi delle sessioni, orari e
   * stati, cioe' testo che si legge davvero. Il caso peggiore e' nord sul
   * pannello in rilievo (2.81:1), cioe' la riga sotto il puntatore. Lasciato
   * come skip perche' correggerlo significa ritoccare le palette, che e' una
   * decisione di progetto e non una riga di codice.
   */
  it.skip('anche il testo attenuato supera 4.5:1 (5 temi su 6 sotto soglia)', () => {
    for (const tema of BUILTIN_THEMES) {
      for (const sfondo of ['desktop', 'panel', 'panelRaised'] as const) {
        const r = contrasto(tema.ui.textDim, tema.ui[sfondo])
        assert.ok(
          r >= 4.5,
          `${tema.id}: ui.textDim su ui.${sfondo} e' ${r.toFixed(2)}:1`
        )
      }
    }
  })

  /**
   * DIFETTO NUOVO, non corretto: nel tema "Alto contrasto" il nero ANSI
   * (ansi[0] = #000000) coincide con lo sfondo del terminale (#000000):
   * contrasto 1.00:1, cioe' testo invisibile. Qualunque programma che stampi
   * in nero — capita nelle barre di avanzamento e nei diff — sparisce del
   * tutto, e proprio nel tema che promette "massima leggibilita'". Negli altri
   * cinque temi ansi[0] e' distinto dallo sfondo.
   */
  it('il nero ANSI non coincide con lo sfondo del terminale (alto-contrasto: 1.00:1)', () => {
    for (const tema of BUILTIN_THEMES) {
      const r = contrasto(tema.terminal.ansi[0], tema.terminal.background)
      assert.ok(r > 1.01, `${tema.id}: ansi[0] sullo sfondo del terminale e' ${r.toFixed(2)}:1`)
    }
  })
})
