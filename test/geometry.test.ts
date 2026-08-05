import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GAP,
  MIN_PANE_H,
  MIN_PANE_W,
  canSplit,
  computeLayout,
  dropSideAt,
  paneInDirection
} from '../src/renderer/src/compositor/geometry'
import type { ComputedLayout, PaneLayout, Rect } from '../src/renderer/src/compositor/geometry'
import {
  EMPTY_LAYOUT,
  addPane,
  setFocus,
  setRatio,
  toggleFloat,
  toggleZoom,
  updateFloating
} from '../src/renderer/src/compositor/layout'
import type { Layout, SplitDir } from '../src/renderer/src/compositor/layout'

/** Il palco di riferimento: una finestra massimizzata su uno schermo comune. */
const PALCO: Rect = { x: 0, y: 0, w: 1600, h: 900 }

/**
 * Costanti private di geometry.ts, ricopiate qui di proposito.
 * Se qualcuno le abbassa, i test sulla porzione visibile devono accorgersene
 * invece di adeguarsi in silenzio.
 */
const MIN_VISIBILE = 80
const INTESTAZIONE_VISIBILE = 30

function calcola(layout: Layout, stage: Rect = PALCO): ComputedLayout {
  return computeLayout(layout, stage)
}

function rettangolo(layout: Layout, id: string, stage: Rect = PALCO): PaneLayout | null {
  return calcola(layout, stage).panes.find((p) => p.id === id) ?? null
}

/** Solo i riquadri del mosaico: i flottanti per definizione si sovrappongono. */
function affiancati(c: ComputedLayout): PaneLayout[] {
  return c.panes.filter((p) => !p.floating)
}

function siSovrappongono(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** La regola dell'app: un riquadro largo si divide in verticale, uno alto in orizzontale. */
function direzioneNaturale(rect: { w: number; h: number } | null): SplitDir {
  return !rect || rect.w >= rect.h ? 'h' : 'v'
}

/** Mosaico di n riquadri, dividendo ogni volta quello attivo come fa l'app. */
function mosaico(n: number, stage: Rect = PALCO): Layout {
  let layout = EMPTY_LAYOUT
  for (let i = 1; i <= n; i++) {
    const attivo = layout.focused ? rettangolo(layout, layout.focused, stage) : null
    layout = addPane(layout, `p${i}`, direzioneNaturale(attivo))
  }
  return layout
}

/**
 * Regressione della issue #10.
 *
 * Non esisteva un lato minimo. Dividendo sempre lo stesso riquadro le larghezze
 * andavano 1600, 796, 394, 193, 92, 42, 17, 4 e infine 0: dall'ottava divisione
 * il riquadro nasceva largo zero. La sessione partiva davvero e consumava
 * token, ma il terminale non era ne' visibile ne' raggiungibile col mouse, e
 * l'unico modo per accorgersene era la bolletta.
 */
describe('geometry: lato minimo di un riquadro (issue #10)', () => {
  it('senza guardia l ottava divisione produce ancora un riquadro largo zero', () => {
    // Il difetto originale, riprodotto: e' la ragione per cui canSplit esiste.
    let layout = EMPTY_LAYOUT
    for (let i = 1; i <= 9; i++) layout = addPane(layout, `p${i}`, 'h')

    const larghezze = affiancati(calcola(layout)).map((p) => p.w)
    assert.equal(larghezze.length, 9)
    assert.equal(Math.min(...larghezze), 0, 'la sequenza storica non e piu riprodotta')
  })

  it('canSplit rifiuta prima che lo spazio finisca', () => {
    // Il quarto riquadro della sequenza storica e' largo 193: qui la guardia
    // deve gia' dire no, molto prima dello zero.
    assert.equal(canSplit({ w: 193, h: 900 }, 'h'), false)

    // Confine esatto: 288 = 140 + 8 + 140, la divisione piu' stretta ammessa.
    assert.equal(canSplit({ w: 288, h: 900 }, 'h'), true)
    assert.equal(canSplit({ w: 287, h: 900 }, 'h'), false)
    assert.equal(canSplit({ w: 1600, h: 188 }, 'v'), true)
    assert.equal(canSplit({ w: 1600, h: 187 }, 'v'), false)

    // Uno stage non ancora misurato, o degenere, non deve mai autorizzare.
    assert.equal(canSplit({ w: 0, h: 0 }, 'h'), false)
    assert.equal(canSplit({ w: 0, h: 0 }, 'v'), false)
    assert.equal(canSplit({ w: -1600, h: -900 }, 'h'), false)
    assert.equal(canSplit({ w: -1600, h: -900 }, 'v'), false)
  })

  it('canSplit dice si esattamente quando la divisione reale resta sopra la soglia', () => {
    // La guardia non deve essere ne' piu' larga (riquadri inservibili) ne' piu'
    // stretta (divisioni rifiutate senza motivo) della divisione che poi avviene.
    const dueOrizzontali = addPane(addPane(EMPTY_LAYOUT, 'a', 'h'), 'b', 'h')
    for (let w = 0; w <= 600; w++) {
      const larghezze = affiancati(calcola(dueOrizzontali, { x: 0, y: 0, w, h: 900 })).map((p) => p.w)
      const sopraSoglia = Math.min(...larghezze) >= MIN_PANE_W
      assert.equal(canSplit({ w, h: 900 }, 'h'), sopraSoglia, `larghezza ${w}`)
    }

    const dueVerticali = addPane(addPane(EMPTY_LAYOUT, 'a', 'v'), 'b', 'v')
    for (let h = 0; h <= 400; h++) {
      const altezze = affiancati(calcola(dueVerticali, { x: 0, y: 0, w: 1600, h })).map((p) => p.h)
      const sopraSoglia = Math.min(...altezze) >= MIN_PANE_H
      assert.equal(canSplit({ w: 1600, h }, 'v'), sopraSoglia, `altezza ${h}`)
    }
  })

  it('dividendo finche canSplit lo consente nessun riquadro scende sotto la soglia', () => {
    let layout = EMPTY_LAYOUT
    let divisioni = 0
    const massimo = 500

    while (divisioni < massimo) {
      const attivo = layout.focused ? rettangolo(layout, layout.focused) : null
      const dir = direzioneNaturale(attivo)
      // Stessa condizione dell'app: quando la guardia dice no la sessione
      // nasce flottante, non dentro un riquadro invisibile.
      if (attivo && !canSplit(attivo, dir)) break
      layout = addPane(layout, `p${divisioni + 1}`, dir)
      divisioni++
    }

    assert.ok(divisioni > 1, 'nessuna divisione consentita su un palco 1600x900')
    assert.ok(divisioni < massimo, 'la guardia non ha mai fermato le divisioni')

    for (const p of affiancati(calcola(layout))) {
      assert.ok(p.w >= MIN_PANE_W, `${p.id} largo ${p.w}, sotto ${MIN_PANE_W}`)
      assert.ok(p.h >= MIN_PANE_H, `${p.id} alto ${p.h}, sotto ${MIN_PANE_H}`)
    }
  })

  it('un riquadro appena sopra la soglia si divide ancora in due riquadri usabili', () => {
    // Il caso limite conta piu' degli altri: e' quello dove la guardia decide.
    const stretto: Rect = { x: 0, y: 0, w: MIN_PANE_W * 2 + GAP, h: MIN_PANE_H * 2 + GAP }
    assert.equal(canSplit(stretto, 'h'), true)
    assert.equal(canSplit(stretto, 'v'), true)

    const diviso = addPane(addPane(EMPTY_LAYOUT, 'a', 'h'), 'b', 'h')
    for (const p of affiancati(calcola(diviso, stretto))) {
      assert.equal(p.w, MIN_PANE_W)
      assert.equal(p.h, stretto.h)
    }
  })
})

describe('geometry: invarianti del mosaico', () => {
  for (const n of [1, 2, 3, 5, 9]) {
    it(`con ${n} riquadri i rettangoli non si sovrappongono e stanno dentro il palco`, () => {
      const panes = affiancati(calcola(mosaico(n)))
      assert.equal(panes.length, n)

      for (const p of panes) {
        for (const valore of [p.x, p.y, p.w, p.h]) {
          assert.ok(Number.isFinite(valore), `${p.id} ha una coordinata non finita`)
        }
        assert.ok(p.w >= 0 && p.h >= 0, `${p.id} ha un lato negativo: ${p.w}x${p.h}`)
        assert.ok(p.x >= PALCO.x, `${p.id} sborda a sinistra`)
        assert.ok(p.y >= PALCO.y, `${p.id} sborda in alto`)
        assert.ok(p.x + p.w <= PALCO.x + PALCO.w, `${p.id} sborda a destra`)
        assert.ok(p.y + p.h <= PALCO.y + PALCO.h, `${p.id} sborda in basso`)
      }

      for (let i = 0; i < panes.length; i++) {
        for (let j = i + 1; j < panes.length; j++) {
          assert.ok(
            !siSovrappongono(panes[i], panes[j]),
            `${panes[i].id} e ${panes[j].id} si coprono a vicenda`
          )
        }
      }
    })
  }

  it('il palco viene usato tutto: i riquadri lasciano solo i canali', () => {
    // Un errore di arrotondamento lascerebbe una striscia morta permanente.
    const panes = affiancati(calcola(mosaico(2)))
    const area = panes.reduce((somma, p) => somma + p.w * p.h, 0)
    assert.equal(area, (PALCO.w - GAP) * PALCO.h)
  })

  it('un palco spostato non e trattato come se stesse nell origine', () => {
    // La finestra ha una barra degli strumenti sopra: se lo scostamento si
    // perde, i riquadri le finiscono sotto.
    const spostato: Rect = { x: 120, y: 48, w: 1000, h: 700 }
    for (const p of affiancati(calcola(mosaico(5, spostato), spostato))) {
      assert.ok(p.x >= spostato.x && p.y >= spostato.y, `${p.id} risale oltre il bordo del palco`)
      assert.ok(p.x + p.w <= spostato.x + spostato.w && p.y + p.h <= spostato.y + spostato.h)
    }
  })

  for (const degenere of [
    { x: 0, y: 0, w: 0, h: 0 },
    { x: 0, y: 0, w: 0, h: 900 },
    { x: 0, y: 0, w: 1600, h: 0 },
    { x: 0, y: 0, w: -1600, h: -900 }
  ]) {
    it(`un palco degenere ${degenere.w}x${degenere.h} non produce numeri assurdi`, () => {
      // Succede davvero: la finestra viene minimizzata e il contenitore misura
      // zero. Basta un NaN qui perche' al ripristino non torni piu' niente.
      const c = calcola(mosaico(3, PALCO), degenere)
      const panes = affiancati(c)
      assert.equal(panes.length, 3)

      for (const p of panes) {
        for (const valore of [p.x, p.y, p.w, p.h]) {
          assert.ok(Number.isFinite(valore), `${p.id}: coordinata non finita`)
        }
        // Nessun riquadro puo' essere piu' grande dello spazio disponibile.
        assert.ok(p.w <= Math.max(0, degenere.w), `${p.id} largo ${p.w} su un palco ${degenere.w}`)
        assert.ok(p.h <= Math.max(0, degenere.h), `${p.id} alto ${p.h} su un palco ${degenere.h}`)
      }

      for (const g of c.gutters) {
        for (const valore of [g.x, g.y, g.w, g.h]) {
          assert.ok(Number.isFinite(valore), 'canale con coordinata non finita')
        }
      }
    })
  }
})

describe('geometry: riquadri flottanti fuori campo', () => {
  /** Un mosaico di due riquadri dove il secondo e' stato staccato. */
  function conFlottante(patch: { x: number; y: number; w: number; h: number }): Layout {
    const base = mosaico(2)
    const rect = rettangolo(base, 'p2')
    assert.ok(rect)
    return updateFloating(toggleFloat(base, 'p2', rect), 'p2', patch)
  }

  const casi = [
    { nome: 'molto a destra, da uno schermo piu largo', x: 5000, y: 200, w: 400, h: 300 },
    { nome: 'molto a sinistra, coordinate negative', x: -5000, y: 100, w: 400, h: 300 },
    { nome: 'sotto il bordo inferiore', x: 300, y: 4000, w: 400, h: 300 },
    { nome: 'sopra il bordo superiore', x: 300, y: -4000, w: 400, h: 300 },
    { nome: 'oltre l angolo in basso a destra', x: 9999, y: 9999, w: 400, h: 300 },
    { nome: 'piu grande dello stage', x: -200, y: -200, w: 5000, h: 4000 },
    { nome: 'minuscolo e fuori campo', x: 9999, y: 9999, w: 10, h: 10 }
  ]

  for (const caso of casi) {
    it(`resta agganciato con una porzione visibile: ${caso.nome}`, () => {
      // Le coordinate salvate arrivano da una sessione precedente, magari su un
      // altro monitor. Senza riaggancio il riquadro esiste ma non si vede e non
      // si puo' riportare indietro col mouse.
      const p = rettangolo(conFlottante(caso), 'p2')
      assert.ok(p)
      assert.equal(p.floating, true)

      for (const valore of [p.x, p.y, p.w, p.h]) {
        assert.ok(Number.isFinite(valore), 'coordinata non finita')
      }
      assert.ok(p.w > 0 && p.h > 0, `flottante degenere ${p.w}x${p.h}`)
      assert.ok(p.w <= PALCO.w && p.h <= PALCO.h, 'flottante piu grande del palco')

      const visibileX = Math.min(p.x + p.w, PALCO.x + PALCO.w) - Math.max(p.x, PALCO.x)
      const visibileY = Math.min(p.y + p.h, PALCO.y + PALCO.h) - Math.max(p.y, PALCO.y)
      assert.ok(
        visibileX >= Math.min(p.w, MIN_VISIBILE),
        `solo ${visibileX} px visibili in orizzontale`
      )
      assert.ok(
        visibileY >= Math.min(p.h, INTESTAZIONE_VISIBILE),
        `solo ${visibileY} px visibili in verticale: l intestazione non si afferra`
      )
    })
  }

  it('l intestazione resta afferrabile anche su un palco spostato', () => {
    // La barra del titolo e' l'unico modo per trascinare indietro un flottante:
    // deve restare sotto il bordo superiore del palco, non sopra.
    const spostato: Rect = { x: 200, y: 90, w: 900, h: 600 }
    const layout = conFlottante({ x: -9999, y: -9999, w: 400, h: 300 })
    const p = rettangolo(layout, 'p2', spostato)
    assert.ok(p)
    assert.ok(p.y >= spostato.y, 'l intestazione e finita sopra il bordo del palco')
    assert.ok(p.x + p.w >= spostato.x + MIN_VISIBILE, 'niente di afferrabile a sinistra')
  })

  it('il flottante sta sopra il mosaico', () => {
    const layout = conFlottante({ x: 100, y: 100, w: 400, h: 300 })
    const c = calcola(layout)
    const flottante = c.panes.find((p) => p.floating)
    assert.ok(flottante)
    for (const p of affiancati(c)) assert.ok(flottante.z > p.z, 'il flottante finisce sotto')
  })
})

describe('geometry: zona di rilascio del trascinamento', () => {
  const larghi: Rect[] = [
    { x: 0, y: 0, w: 1000, h: 600 },
    // Molto largo e basso: senza normalizzare, i bordi alto e basso sarebbero
    // irraggiungibili e non si potrebbe piu' affiancare sopra o sotto.
    { x: 0, y: 0, w: 1200, h: 60 },
    // Molto stretto e alto: il caso speculare.
    { x: 0, y: 0, w: 60, h: 1200 },
    // Con scostamento: il rettangolo non e' quasi mai nell'origine.
    { x: 340, y: 120, w: 500, h: 300 }
  ]

  for (const r of larghi) {
    it(`i quattro bordi e il centro di ${r.w}x${r.h} danno il lato giusto`, () => {
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      assert.equal(dropSideAt(r, { x: r.x + 1, y: cy }), 'left')
      assert.equal(dropSideAt(r, { x: r.x + r.w - 1, y: cy }), 'right')
      assert.equal(dropSideAt(r, { x: cx, y: r.y + 1 }), 'top')
      assert.equal(dropSideAt(r, { x: cx, y: r.y + r.h - 1 }), 'bottom')
      assert.equal(dropSideAt(r, { x: cx, y: cy }), 'center')
    })

    it(`i quattro angoli di ${r.w}x${r.h} non vengono presi per il centro`, () => {
      // Sull'angolo la scelta fra i due lati adiacenti e' opinabile, ma
      // scambiare i riquadri quando si punta un angolo non lo e' mai.
      const angoli = [
        { p: { x: r.x + 1, y: r.y + 1 }, ammessi: ['left', 'top'] },
        { p: { x: r.x + r.w - 1, y: r.y + 1 }, ammessi: ['right', 'top'] },
        { p: { x: r.x + 1, y: r.y + r.h - 1 }, ammessi: ['left', 'bottom'] },
        { p: { x: r.x + r.w - 1, y: r.y + r.h - 1 }, ammessi: ['right', 'bottom'] }
      ]
      for (const { p, ammessi } of angoli) {
        const lato = dropSideAt(r, p)
        assert.ok(ammessi.includes(lato), `angolo ${p.x},${p.y} ha dato ${lato}`)
      }
    })
  }

  it('la zona centrale e piccola e simmetrica', () => {
    // Se il centro fosse largo, si scambierebbero riquadri credendo di
    // affiancarli. Poco oltre un quinto dal centro si deve gia' affiancare.
    const r: Rect = { x: 0, y: 0, w: 1000, h: 1000 }
    assert.equal(dropSideAt(r, { x: 500 + 200, y: 500 }), 'center')
    assert.equal(dropSideAt(r, { x: 500 + 230, y: 500 }), 'right')
    assert.equal(dropSideAt(r, { x: 500 - 230, y: 500 }), 'left')
    assert.equal(dropSideAt(r, { x: 500, y: 500 - 230 }), 'top')
    assert.equal(dropSideAt(r, { x: 500, y: 500 + 230 }), 'bottom')
  })

  it('un rettangolo degenere non manda in crisi il calcolo', () => {
    // Capita mentre il layout si sta ancora misurando: deve dare una risposta
    // valida invece di NaN o di un lato inventato.
    for (const r of [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: 1, h: 0 },
      { x: 0, y: 0, w: -10, h: -10 }
    ]) {
      const lato = dropSideAt(r, { x: 0, y: 0 })
      assert.ok(['left', 'right', 'top', 'bottom', 'center'].includes(lato))
    }
  })

  it('ogni punto interno riceve una sola zona, mai indefinita', () => {
    const r: Rect = { x: 10, y: 20, w: 333, h: 177 }
    for (let x = r.x; x <= r.x + r.w; x += 7) {
      for (let y = r.y; y <= r.y + r.h; y += 7) {
        const lato = dropSideAt(r, { x, y })
        assert.ok(
          ['left', 'right', 'top', 'bottom', 'center'].includes(lato),
          `punto ${x},${y} senza zona`
        )
      }
    }
  })
})

describe('geometry: spostamento del fuoco fra riquadri', () => {
  /**
   * Griglia 2x2 nota:
   *   p1 p2
   *   p3 p4
   */
  function griglia(): Layout {
    let layout = addPane(EMPTY_LAYOUT, 'p1', 'h')
    layout = addPane(layout, 'p2', 'h') // p1 | p2
    layout = addPane(setFocus(layout, 'p1'), 'p3', 'v') // p1 sopra p3
    layout = addPane(setFocus(layout, 'p2'), 'p4', 'v') // p2 sopra p4
    return layout
  }

  const vicini: [string, 'left' | 'right' | 'up' | 'down', string | null][] = [
    ['p1', 'right', 'p2'],
    ['p1', 'down', 'p3'],
    ['p1', 'left', null],
    ['p1', 'up', null],
    ['p2', 'left', 'p1'],
    ['p2', 'down', 'p4'],
    ['p2', 'right', null],
    ['p2', 'up', null],
    ['p3', 'up', 'p1'],
    ['p3', 'right', 'p4'],
    ['p3', 'down', null],
    ['p3', 'left', null],
    ['p4', 'up', 'p2'],
    ['p4', 'left', 'p3'],
    ['p4', 'right', null],
    ['p4', 'down', null]
  ]

  for (const [da, verso, atteso] of vicini) {
    it(`da ${da} verso ${verso} porta a ${atteso ?? 'nessun riquadro'}`, () => {
      // Verso l'esterno deve dare null: il fuoco non deve saltare dall'altra
      // parte dello schermo quando si e' gia' sul bordo.
      const panes = calcola(griglia()).panes
      assert.equal(paneInDirection(panes, da, verso), atteso)
    })
  }

  it('preferisce il vicino in linea a uno piu vicino ma di traverso', () => {
    /**
     * Disposizione scelta apposta perche' i due criteri litighino:
     *
     *   pA      |        pC        (riga in alto)
     *   p1 |          pB           (riga in basso)
     *
     * Il centro di pA dista ~456 px da quello di p1, quello di pB ~804: a
     * distanza secca vincerebbe pA, che pero' sta SOPRA. Premendo "destra" si
     * deve finire in pB, e premendo "su" in pA.
     */
    let layout = addPane(EMPTY_LAYOUT, 'pA', 'h')
    layout = addPane(layout, 'p1', 'v')
    layout = addPane(setFocus(layout, 'pA'), 'pC', 'h')
    layout = addPane(setFocus(layout, 'p1'), 'pB', 'h')
    layout = setRatio(layout, 'a', 0.25) // riga alta: pA stretto
    layout = setRatio(layout, 'b', 0.2) // riga bassa: p1 stretto, pB larghissimo

    const panes = calcola(layout).panes
    const p1 = panes.find((q) => q.id === 'p1')
    assert.ok(p1)
    const distanzaDaP1 = (id: string): number => {
      const p = panes.find((q) => q.id === id)
      assert.ok(p)
      return Math.hypot(p.x + p.w / 2 - (p1.x + p1.w / 2), p.y + p.h / 2 - (p1.y + p1.h / 2))
    }
    assert.ok(
      distanzaDaP1('pA') < distanzaDaP1('pB'),
      'la disposizione non mette piu i due criteri in conflitto'
    )

    assert.equal(paneInDirection(panes, 'p1', 'right'), 'pB')
    assert.equal(paneInDirection(panes, 'p1', 'up'), 'pA')
  })

  it('un riquadro che non esiste non muove il fuoco', () => {
    const panes = calcola(griglia()).panes
    assert.equal(paneInDirection(panes, 'fantasma', 'right'), null)
  })

  it('un solo riquadro non ha vicini in nessuna direzione', () => {
    const panes = calcola(mosaico(1)).panes
    for (const verso of ['left', 'right', 'up', 'down'] as const) {
      assert.equal(paneInDirection(panes, 'p1', verso), null)
    }
  })
})

describe('geometry: riquadro ingrandito', () => {
  it('con lo zoom attivo si vede solo il riquadro ingrandito', () => {
    const base = mosaico(5)
    const rect = rettangolo(base, 'p5')
    assert.ok(rect)
    // Anche un flottante, che di norma copre tutto, deve sparire sotto lo zoom.
    const conFlottante = toggleFloat(base, 'p5', { x: 200, y: 200, w: 500, h: 400 })
    const c = calcola(toggleZoom(conFlottante, 'p3'))

    const visibili = c.panes.filter((p) => !p.hidden)
    assert.deepEqual(
      visibili.map((p) => p.id),
      ['p3']
    )

    const zoom = visibili[0]
    assert.deepEqual({ x: zoom.x, y: zoom.y, w: zoom.w, h: zoom.h }, PALCO)
    for (const p of c.panes) {
      if (p.id !== 'p3') assert.ok(zoom.z > p.z, `${p.id} resta sopra il riquadro ingrandito`)
    }
    // Senza mosaico visibile non c'e' niente da ridimensionare: un canale
    // trascinabile sopra lo zoom cambierebbe un layout che non si vede.
    assert.deepEqual(c.gutters, [])
  })

  it('i riquadri nascosti restano a dimensione piena', () => {
    // Azzerarli farebbe ridimensionare il PTY, e al ritorno dallo zoom il
    // contenuto del terminale sarebbe gia' stato rimpaginato a vuoto.
    const senzaZoom = calcola(mosaico(4))
    const conZoom = calcola(toggleZoom(mosaico(4), 'p2'))

    for (const prima of affiancati(senzaZoom)) {
      if (prima.id === 'p2') continue
      const dopo = conZoom.panes.find((p) => p.id === prima.id)
      assert.ok(dopo)
      assert.equal(dopo.hidden, true)
      assert.equal(dopo.w, prima.w)
      assert.equal(dopo.h, prima.h)
    }
  })

  it('il fuoco non si sposta verso un riquadro nascosto dallo zoom', () => {
    // Con un solo riquadro visibile, le frecce non devono portare in un
    // terminale che l'utente non vede.
    const c = calcola(toggleZoom(mosaico(4), 'p2'))
    for (const verso of ['left', 'right', 'up', 'down'] as const) {
      assert.equal(paneInDirection(c.panes, 'p2', verso), null)
    }
  })

  it('togliendo lo zoom tornano tutti visibili al loro posto', () => {
    const layout = mosaico(4)
    const prima = calcola(layout)
    const dopo = calcola(toggleZoom(toggleZoom(layout, 'p2'), 'p2'))
    assert.deepEqual(dopo, prima)
  })
})
