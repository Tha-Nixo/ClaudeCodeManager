import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACTION_LABELS,
  DEFAULT_KEYMAP,
  installKeyHandler,
  keyForAction,
  normalizeCombo,
  prettyKey,
  resolveKeymap,
  signature,
  type Action
} from '../src/renderer/src/keys/bindings'

/**
 * Evento finto: `signature` legge solo questi campi, e costruirli a mano
 * permette di riprodurre tastiere che qui non ci sono (italiana, francese)
 * senza dipendere dal layout di chi esegue i test.
 */
interface FintoEvento {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  key: string
  code: string
  bloccato: boolean
  preventDefault(): void
  stopPropagation(): void
}

function tasto(spec: {
  key: string
  /** Assente quando il tasto non ha un `code` interessante (frecce, F11...). */
  code?: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}): FintoEvento {
  const e: FintoEvento = {
    ctrlKey: spec.ctrl ?? false,
    altKey: spec.alt ?? false,
    shiftKey: spec.shift ?? false,
    metaKey: spec.meta ?? false,
    key: spec.key,
    code: spec.code ?? '',
    bloccato: false,
    preventDefault() {
      e.bloccato = true
    },
    stopPropagation() {}
  }
  return e
}

/** `signature` accetta un KeyboardEvent vero; qui ne basta la forma. */
function firma(e: FintoEvento): string {
  return signature(e as unknown as KeyboardEvent)
}

describe('normalizeCombo: tasti che sparivano nella normalizzazione (Regressione della issue #7)', () => {
  /**
   * Chi assegnava Alt+Spazio o Alt+Shift++ perdeva la scorciatoia vecchia e non
   * ne otteneva una nuova: il tasto veniva scartato e l'ultimo modificatore
   * scambiato per il tasto. Le due combinazioni devono sopravvivere intere.
   */
  it('conserva la barra spaziatrice come tasto', () => {
    assert.equal(normalizeCombo('alt+ '), 'alt+ ')
    assert.equal(normalizeCombo('ctrl+shift+ '), 'ctrl+shift+ ')
    // Senza modificatori resta comunque un tasto, non una stringa vuota.
    assert.equal(normalizeCombo(' '), ' ')
  })

  it('conserva il tasto + anche quando segue altri +', () => {
    assert.equal(normalizeCombo('alt+shift++'), 'alt+shift++')
    assert.equal(normalizeCombo('alt++'), 'alt++')
    assert.equal(normalizeCombo('+'), '+')
  })

  it('non degrada mai la combinazione al solo modificatore', () => {
    // Il sintomo visibile del difetto: il pannello mostrava «Alt» come tasto
    // assegnato, e l'utente si ritrovava con una scorciatoia inservibile.
    for (const raw of ['alt+ ', 'alt++', 'alt+shift++', 'ctrl+shift+ ']) {
      const combo = normalizeCombo(raw)
      assert.notEqual(combo, 'alt', `${raw} e' collassato sul modificatore`)
      assert.notEqual(combo, 'shift', `${raw} e' collassato sul modificatore`)
      assert.notEqual(combo, 'alt+shift', `${raw} e' collassato sul modificatore`)
      assert.notEqual(combo, 'ctrl+shift', `${raw} e' collassato sul modificatore`)
    }
  })

  it('la combinazione salvata corrisponde davvero alla pressione dei tasti', () => {
    // Il vero scopo della normalizzazione: quello che il pannello scrive nel
    // file deve combaciare con la firma che l'evento produrra' alla pressione.
    assert.equal(normalizeCombo('alt+ '), firma(tasto({ key: ' ', code: 'Space', alt: true })))
    // Su tastiera italiana il '+' si batte con Shift+tasto ']'.
    assert.equal(
      normalizeCombo('alt+shift++'),
      firma(tasto({ key: '+', code: 'BracketRight', alt: true, shift: true }))
    )
  })

  it('spostare una scorciatoia su Alt+Spazio la crea davvero', () => {
    // Sequenza esatta scritta dal pannello quando si rimappa: la vecchia voce
    // viene liberata e la nuova aggiunta. Prima la prima meta' riusciva e la
    // seconda finiva su 'alt', lasciando l'azione senza tasto.
    const { keymap, problems } = resolveKeymap({ 'alt+z': '', 'alt+ ': 'toggle-zoom' })

    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+ '], 'toggle-zoom')
    assert.equal(keymap['alt+z'], undefined)
    // Nessuna voce fantasma sul solo modificatore: intercetterebbe Alt da solo.
    assert.equal(keymap['alt'], undefined)
    assert.equal(keyForAction('toggle-zoom', keymap), prettyKey('alt+ '))
  })

  it('il pannello mostra un nome leggibile per la barra spaziatrice', () => {
    // DIFETTO NUOVO osservato: prettyKey('alt+ ') restituisce 'Alt+ ', che a
    // schermo si legge «Alt+» — identico a una scorciatoia rotta. Chi ha
    // assegnato Alt+Spazio non ha modo di sapere che il tasto c'e'.
    assert.equal(prettyKey('alt+ '), 'Alt+Spazio')
  })
})

describe('ACTION_LABELS: ogni azione e\' visibile e rimappabile (Regressione della issue #14)', () => {
  const etichettate = new Set(ACTION_LABELS.map((v) => v.action))
  const assegnate = new Set<Action>(Object.values(DEFAULT_KEYMAP))

  it('ogni azione della mappa predefinita compare nel pannello', () => {
    // Le nove focus-1..focus-9 mancavano: non erano scopribili, non erano
    // rimappabili e non erano liberabili, senza che nulla lo rivelasse.
    const mancanti = [...assegnate].filter((a) => !etichettate.has(a))
    assert.deepEqual(mancanti, [], `azioni senza riga nel pannello: ${mancanti.join(', ')}`)
  })

  it('le nove scorciatoie numeriche sono elencate', () => {
    for (let i = 1; i <= 9; i++) {
      const azione = `focus-${i}` as Action
      assert.ok(etichettate.has(azione), `${azione} non e' nel pannello`)
      assert.ok(assegnate.has(azione), `${azione} non ha una combinazione predefinita`)
    }
  })

  it('ogni riga del pannello corrisponde a un\'azione esistente', () => {
    // Una riga senza azione mostrerebbe una scorciatoia che non fa niente.
    const orfane = [...etichettate].filter((a) => !assegnate.has(a))
    assert.deepEqual(orfane, [], `righe senza azione corrispondente: ${orfane.join(', ')}`)
  })

  it('nessuna riga ripetuta e nessuna etichetta ambigua', () => {
    // Due righe con la stessa azione o lo stesso testo sono indistinguibili:
    // l'utente rimappa una delle due e vede cambiare l'altra.
    assert.equal(etichettate.size, ACTION_LABELS.length, 'azione ripetuta nel pannello')
    const testi = new Set(ACTION_LABELS.map((v) => v.label))
    assert.equal(testi.size, ACTION_LABELS.length, 'due righe con la stessa etichetta')
    for (const { action, label } of ACTION_LABELS) {
      assert.ok(label.trim().length > 0, `${action} ha un'etichetta vuota`)
    }
  })
})

describe('mappa predefinita: nessuna collisione e forma canonica', () => {
  it('nessuna combinazione porta due azioni', () => {
    // Un doppione nel letterale svanirebbe in silenzio: il sintomo e' che le
    // azioni assegnate diventano meno delle combinazioni dichiarate.
    const combos = Object.keys(DEFAULT_KEYMAP)
    const azioni = new Set(Object.values(DEFAULT_KEYMAP))
    assert.equal(
      azioni.size,
      combos.length,
      'una combinazione ha rimpiazzato un\'altra: azioni distinte diverse dal numero di voci'
    )
  })

  it('ogni combinazione e\' gia\' in forma canonica', () => {
    // Se non lo fosse, la combinazione salvata dal pannello (normalizzata) non
    // corrisponderebbe mai a quella predefinita e l'azione resterebbe muta.
    for (const combo of Object.keys(DEFAULT_KEYMAP)) {
      assert.equal(normalizeCombo(combo), combo, `${combo} non e' in forma canonica`)
    }
  })

  it('nessuna combinazione usa Ctrl e Alt insieme', () => {
    // Su tastiera italiana AltGr produce ctrlKey+altKey: intercettare una di
    // quelle combinazioni toglierebbe a chi scrive caratteri come @ # [ ] { }.
    for (const combo of Object.keys(DEFAULT_KEYMAP)) {
      const mods = combo.split('+')
      assert.ok(
        !(mods.includes('ctrl') && mods.includes('alt')),
        `${combo} verrebbe attivata da AltGr`
      )
    }
  })
})

describe('signature: nome del tasto indipendente dal layout', () => {
  it('lettere e cifre vengono dal code, non dal carattere prodotto', () => {
    // Su tastiere non QWERTY il carattere cambia ma la posizione no: Alt+B
    // deve restare Alt+B, altrimenti la scorciatoia si sposta col layout.
    assert.equal(firma(tasto({ key: 'ß', code: 'KeyB', alt: true })), 'alt+b')
    assert.equal(firma(tasto({ key: 'B', code: 'KeyB', alt: true, shift: true })), 'alt+shift+b')
    // Cifre: su layout francese Alt+1 produce '&'.
    assert.equal(firma(tasto({ key: '&', code: 'Digit1', alt: true })), 'alt+1')
    assert.equal(DEFAULT_KEYMAP[firma(tasto({ key: '&', code: 'Digit1', alt: true }))], 'focus-1')
  })

  it('i tasti speciali hanno il nome usato nella mappa', () => {
    assert.equal(firma(tasto({ key: 'ArrowLeft', alt: true })), 'alt+left')
    assert.equal(firma(tasto({ key: 'ArrowRight', alt: true, shift: true })), 'alt+shift+right')
    assert.equal(firma(tasto({ key: 'ArrowUp', alt: true })), 'alt+up')
    assert.equal(firma(tasto({ key: 'ArrowDown', alt: true })), 'alt+down')
    assert.equal(firma(tasto({ key: 'Enter', alt: true })), 'alt+enter')
    assert.equal(firma(tasto({ key: 'Escape' })), 'escape')
    assert.equal(firma(tasto({ key: 'F11' })), 'f11')
  })

  it('i modificatori escono sempre nello stesso ordine', () => {
    // L'ordine e' il contratto fra evento e mappa: cambiarlo renderebbe muta
    // ogni scorciatoia con piu' di un modificatore.
    assert.equal(
      firma(tasto({ key: 'x', code: 'KeyX', meta: true, shift: true, alt: true, ctrl: true })),
      'ctrl+alt+shift+meta+x'
    )
    assert.equal(firma(tasto({ key: 'q', code: 'KeyQ', ctrl: true, shift: true })), 'ctrl+shift+q')
    assert.equal(DEFAULT_KEYMAP[firma(tasto({ key: 'q', code: 'KeyQ', ctrl: true, shift: true }))], 'quit')
  })

  it('AltGr non attiva mai una scorciatoia predefinita', () => {
    // Su tastiera italiana AltGr = ctrlKey + altKey. Se una di queste finisse
    // in mappa, l'utente non riuscirebbe piu' a scrivere quel carattere: il
    // compositor lo intercetterebbe e il terminale non lo vedrebbe mai.
    const altgr = [
      tasto({ key: '@', code: 'Semicolon', ctrl: true, alt: true }),
      tasto({ key: '#', code: 'Quote', ctrl: true, alt: true }),
      tasto({ key: '[', code: 'BracketLeft', ctrl: true, alt: true }),
      tasto({ key: ']', code: 'BracketRight', ctrl: true, alt: true }),
      tasto({ key: '{', code: 'BracketLeft', ctrl: true, alt: true, shift: true }),
      tasto({ key: '}', code: 'BracketRight', ctrl: true, alt: true, shift: true }),
      // AltGr su una lettera (€ su molti layout): il code la fa diventare 'e'.
      tasto({ key: '€', code: 'KeyE', ctrl: true, alt: true }),
      // AltGr su una cifra, per lo stesso motivo.
      tasto({ key: '~', code: 'Digit1', ctrl: true, alt: true })
    ]

    for (const e of altgr) {
      const sig = firma(e)
      assert.ok(sig.startsWith('ctrl+alt'), `${sig} non riporta entrambi i modificatori`)
      assert.equal(DEFAULT_KEYMAP[sig], undefined, `AltGr+${e.key} verrebbe rubato all'utente`)
    }
  })
})

describe('installKeyHandler: cosa viene intercettato e cosa passa al terminale', () => {
  /** Finestra finta: l'ascoltatore si richiama a mano, senza DOM. */
  function conFinestra(prova: (premi: (e: FintoEvento) => void, stacca: () => void) => void): void {
    const ascoltatori: ((e: KeyboardEvent) => void)[] = []
    const finta = {
      addEventListener: (tipo: string, fn: (e: KeyboardEvent) => void) => {
        if (tipo === 'keydown') ascoltatori.push(fn)
      },
      removeEventListener: (tipo: string, fn: (e: KeyboardEvent) => void) => {
        const i = ascoltatori.indexOf(fn)
        if (i >= 0) ascoltatori.splice(i, 1)
      }
    }
    const precedente = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = finta
    try {
      prova(
        (e) => {
          for (const fn of [...ascoltatori]) fn(e as unknown as KeyboardEvent)
        },
        () => assert.equal(ascoltatori.length, 0, 'ascoltatore non rimosso')
      )
    } finally {
      ;(globalThis as Record<string, unknown>).window = precedente
    }
  }

  it('esegue l\'azione in mappa e lascia passare tutto il resto', () => {
    conFinestra((premi) => {
      const fatte: Action[] = []
      const stacca = installKeyHandler({ isEnabled: () => true, onAction: (a) => fatte.push(a) })

      const inMappa = tasto({ key: 'b', code: 'KeyB', alt: true })
      premi(inMappa)
      assert.deepEqual(fatte, ['split-h'])
      assert.equal(inMappa.bloccato, true, 'la combinazione in mappa deve essere fermata')

      // Una lettera qualunque e un AltGr devono arrivare intatti a Claude Code.
      for (const e of [
        tasto({ key: 'a', code: 'KeyA' }),
        tasto({ key: '@', code: 'Semicolon', ctrl: true, alt: true }),
        tasto({ key: '[', code: 'BracketLeft', ctrl: true, alt: true })
      ]) {
        premi(e)
        assert.equal(e.bloccato, false, `${e.key} non deve essere intercettato`)
      }
      assert.deepEqual(fatte, ['split-h'])

      stacca()
    })
  })

  it('a compositor disabilitato non intercetta niente', () => {
    conFinestra((premi) => {
      const fatte: Action[] = []
      installKeyHandler({ isEnabled: () => false, onAction: (a) => fatte.push(a) })

      const e = tasto({ key: 'b', code: 'KeyB', alt: true })
      premi(e)
      // Con un overlay aperto la combinazione deve raggiungere il campo di
      // testo sottostante, non muovere i riquadri dietro.
      assert.deepEqual(fatte, [])
      assert.equal(e.bloccato, false)
    })
  })

  it('usa la mappa personalizzata e si stacca del tutto', () => {
    conFinestra((premi, verificaStaccato) => {
      const fatte: Action[] = []
      const { keymap } = resolveKeymap({ 'alt+b': '', 'ctrl+shift+b': 'split-h' })
      const stacca = installKeyHandler({
        keymap,
        isEnabled: () => true,
        onAction: (a) => fatte.push(a)
      })

      const liberata = tasto({ key: 'b', code: 'KeyB', alt: true })
      premi(liberata)
      // Alt+B liberata deve tornare a readline, non restare intercettata.
      assert.deepEqual(fatte, [])
      assert.equal(liberata.bloccato, false)

      premi(tasto({ key: 'b', code: 'KeyB', ctrl: true, shift: true }))
      assert.deepEqual(fatte, ['split-h'])

      stacca()
      verificaStaccato()
      premi(tasto({ key: 'b', code: 'KeyB', ctrl: true, shift: true }))
      assert.deepEqual(fatte, ['split-h'], 'l\'ascoltatore ha continuato a rispondere')
    })
  })
})

describe('normalizeCombo: ordine canonico e modificatori sconosciuti', () => {
  it('riordina i modificatori come li produce l\'evento', () => {
    // Il file si scrive a mano: nessuno indovina l'ordine al primo colpo, e
    // una combinazione fuori ordine non corrisponderebbe mai a niente.
    assert.equal(normalizeCombo('shift+alt+b'), 'alt+shift+b')
    assert.equal(normalizeCombo('meta+shift+alt+ctrl+x'), 'ctrl+alt+shift+meta+x')
    assert.equal(normalizeCombo('shift+ctrl+q'), 'ctrl+shift+q')
    // E il risultato coincide con la firma dell'evento corrispondente.
    assert.equal(normalizeCombo('shift+alt+b'), firma(tasto({ key: 'b', code: 'KeyB', alt: true, shift: true })))
  })

  it('accetta maiuscole, spazi di contorno e modificatori ripetuti', () => {
    assert.equal(normalizeCombo('ALT+Shift+B'), 'alt+shift+b')
    assert.equal(normalizeCombo('alt + b'), 'alt+b')
    assert.equal(normalizeCombo(' alt+B '), 'alt+b')
    assert.equal(normalizeCombo('alt+alt+b'), 'alt+b')
  })

  it('rifiuta i modificatori che non esistono', () => {
    // Meglio niente che una combinazione plausibile e sbagliata: 'super' verrebbe
    // scambiato per il tasto, e la scorciatoia si attiverebbe a caso.
    for (const raw of ['super+b', 'ctrl+super+b', 'cmd+k', 'option+b', 'alt+ctrlx+b', 'win+shift+b']) {
      assert.equal(normalizeCombo(raw), null, `${raw} avrebbe dovuto essere rifiutata`)
    }
  })

  it('non inventa modificatori dove non ci sono', () => {
    assert.equal(normalizeCombo('f11'), 'f11')
    assert.equal(normalizeCombo('ctrl'), 'ctrl')
  })
})

describe('resolveKeymap: mappa personalizzata malformata', () => {
  it('senza personalizzazioni restituisce esattamente i predefiniti', () => {
    const { keymap, problems } = resolveKeymap(undefined)
    assert.deepEqual(problems, [])
    assert.deepEqual(keymap, { ...DEFAULT_KEYMAP })
  })

  it('non modifica i predefiniti fra una chiamata e l\'altra', () => {
    // Se la mappa predefinita venisse mutata, una modifica sbagliata resterebbe
    // in vigore anche dopo aver ripulito il file di configurazione.
    resolveKeymap({ 'alt+n': '', 'alt+z': 'quit' })
    assert.equal(DEFAULT_KEYMAP['alt+n'], 'new-session')
    assert.equal(DEFAULT_KEYMAP['alt+z'], 'toggle-zoom')
    assert.deepEqual(resolveKeymap(undefined).keymap, { ...DEFAULT_KEYMAP })
  })

  it('scarta le azioni inesistenti dicendo quale', () => {
    const { keymap, problems } = resolveKeymap({
      'alt+k': 'kill-them-all',
      'alt+j': 'focus-1',
      'alt+h': 'Focus-1'
    })

    assert.equal(keymap['alt+k'], undefined, 'un\'azione inventata non deve entrare in mappa')
    // Le azioni sono sensibili alle maiuscole: meglio rifiutare che indovinare.
    assert.equal(keymap['alt+h'], undefined)
    assert.equal(keymap['alt+j'], 'focus-1')

    const segnalate = problems.map((p) => p.combo).sort()
    assert.deepEqual(segnalate, ['alt+h', 'alt+k'])
    for (const p of problems) {
      assert.ok(p.reason.length > 0, `${p.combo} scartata senza spiegazione`)
    }
  })

  it('scarta le combinazioni malformate segnalandole in chiaro', () => {
    // Devono essere elencate, non ignorate: chi ha scritto 'super+b' deve
    // capire perche' la sua scorciatoia non funziona.
    const { keymap, problems } = resolveKeymap({ 'super+b': 'quit', 'cmd+k': 'close-pane' })

    assert.equal(problems.length, 2)
    assert.deepEqual(
      problems.map((p) => p.combo).sort(),
      ['cmd+k', 'super+b'],
      'la voce scartata va mostrata come l\'utente l\'ha scritta'
    )
    // Nessuna interpretazione di ripiego: niente 'b' o 'k' finiti in mappa.
    assert.equal(keymap['b'], undefined)
    assert.equal(keymap['k'], undefined)
    assert.equal(keymap['ctrl+shift+q'], 'quit')
  })

  it('spiega la ragione vera di una combinazione malformata', () => {
    // DIFETTO NUOVO osservato: 'super+b' viene scartata con la ragione
    // «combinazione vuota», che non e' quello che l'utente ha scritto. Il
    // messaggio manda a cercare il problema dalla parte sbagliata.
    const { problems } = resolveKeymap({ 'super+b': 'quit' })
    assert.ok(
      /modificatore/i.test(problems[0].reason),
      `ragione fuorviante: ${problems[0].reason}`
    )
  })

  it('rifiuta una combinazione vuota invece di assegnare il tasto +', () => {
    // DIFETTO NUOVO osservato: normalizeCombo('') restituisce '+', quindi una
    // riga vuota nel file lega silenziosamente il tasto '+' a un'azione. Chi
    // scrive '+' nel terminale se lo vede mangiare senza sapere perche', e la
    // voce non compare fra i problemi.
    assert.equal(normalizeCombo(''), null)
    const { keymap, problems } = resolveKeymap({ '': 'quit' })
    assert.equal(keymap['+'], undefined)
    assert.equal(problems.length, 1)
  })

  it('applica la personalizzazione sopra i predefiniti, non al posto loro', () => {
    // Chi sposta una sola combinazione non deve ridichiarare le altre venti.
    const { keymap, problems } = resolveKeymap({ 'alt+z': 'toggle-usage' })
    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+z'], 'toggle-usage')
    assert.equal(keymap['alt+n'], 'new-session')
    assert.equal(Object.keys(keymap).length, Object.keys(DEFAULT_KEYMAP).length)
  })

  it('l\'azione vuota libera la combinazione', () => {
    // Unico modo per restituire Alt+B a readline senza rimpiazzarla.
    const { keymap, problems } = resolveKeymap({ 'alt+b': '' })
    assert.deepEqual(problems, [])
    assert.equal(keymap['alt+b'], undefined)
    assert.equal(keyForAction('split-h', keymap), null, 'l\'azione non deve piu\' mostrare un tasto')
  })

  it('liberare una combinazione mai assegnata non e\' un errore', () => {
    const { keymap, problems } = resolveKeymap({ 'alt+shift+p': '' })
    assert.deepEqual(problems, [])
    assert.deepEqual(keymap, { ...DEFAULT_KEYMAP })
  })

  it('una combinazione fuori ordine sostituisce quella predefinita', () => {
    // Senza normalizzazione si aggiungerebbe una voce morta accanto a quella
    // vecchia, e l'utente vedrebbe l'azione originale rispondere ancora.
    const { keymap } = resolveKeymap({ 'SHIFT+Alt+left': 'toggle-usage' })
    assert.equal(keymap['alt+shift+left'], 'toggle-usage')
    assert.equal(keymap['shift+alt+left'], undefined)
    assert.equal(Object.keys(keymap).length, Object.keys(DEFAULT_KEYMAP).length)
  })

  it('due scritture della stessa combinazione non ne creano due', () => {
    // 'shift+alt+b' e 'alt+shift+b' sono lo stesso tasto: deve restarne una
    // sola, con l'ultima scritta a vincere, altrimenti quale delle due agisce
    // dipenderebbe dall'ordine interno della mappa.
    const { keymap } = resolveKeymap({ 'shift+alt+b': 'toggle-usage', 'alt+shift+b': 'quit' })
    const suQuellaCombinazione = Object.keys(keymap).filter(
      (c) => normalizeCombo(c) === 'alt+shift+b'
    )
    assert.deepEqual(suQuellaCombinazione, ['alt+shift+b'])
    assert.equal(keymap['alt+shift+b'], 'quit')
  })

  it('la mappa risolta resta utilizzabile dagli eventi reali', () => {
    // Prova d'insieme: dopo una personalizzazione, ogni combinazione della
    // mappa e' ancora in forma canonica e nessuna usa Ctrl+Alt (AltGr).
    const { keymap } = resolveKeymap({ 'Shift+ALT+b': 'toggle-usage', 'alt+ ': 'search-pane' })
    for (const combo of Object.keys(keymap)) {
      assert.equal(normalizeCombo(combo), combo, `${combo} non e' in forma canonica`)
      const parti = combo.split('+')
      assert.ok(!(parti.includes('ctrl') && parti.includes('alt')), `${combo} collide con AltGr`)
    }
  })
})

describe('prettyKey e keyForAction: quello che vede l\'utente', () => {
  it('traduce modificatori e frecce', () => {
    assert.equal(prettyKey('alt+shift+left'), 'Alt+Shift+←')
    assert.equal(prettyKey('alt+enter'), 'Alt+Invio')
    assert.equal(prettyKey('ctrl+shift+q'), 'Ctrl+Shift+Q')
    assert.equal(prettyKey('f11'), 'F11')
  })

  it('mostra il tasto dell\'azione, o niente se e\' stata liberata', () => {
    assert.equal(keyForAction('quit'), 'Ctrl+Shift+Q')
    assert.equal(keyForAction('focus-1'), 'Alt+1')
    const { keymap } = resolveKeymap({ 'ctrl+shift+q': '' })
    assert.equal(keyForAction('quit', keymap), null)
  })
})
