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
 * Invariants of the layout tree.
 *
 * The tree is the only thing holding the open sessions together: if an id
 * appears twice, the same terminal is drawn in two places and the two panes
 * fight over the same PTY; if focus points to a pane that no longer exists,
 * the keyboard stops reaching anything; if a ratio becomes non-finite, both
 * children of the split vanish from the screen (geometry.ts computes widths
 * with Math.round(usable * ratio)).
 *
 * None of these breakages raises an error: the app stays alive and wrong.
 * That is why the shape of the tree is checked after EVERY operation, not just
 * at the end.
 */

/** Limits documented in layout.ts; they are not exported, so they are repeated here. */
const MIN_RATIO = 0.1
const MAX_RATIO = 0.9

/**
 * Checks all the invariants of a layout at once.
 * Throws with a message saying which operation broke what.
 */
function verifyTree(layout: Layout, context = ''): void {
  const where = context ? ` [${context}]` : ''

  assert.ok(layout && typeof layout === 'object', `missing layout${where}`)
  assert.ok(Array.isArray(layout.floating), `floating is not an array${where}`)

  const inTiling: string[] = []

  const visit = (node: LayoutNode | null | undefined, path: string): void => {
    assert.ok(node, `null node at '${path}'${where}`)
    if (node.kind === 'leaf') {
      assert.equal(typeof node.id, 'string', `leaf without id at '${path}'${where}`)
      inTiling.push(node.id)
      return
    }
    assert.equal(node.kind, 'split', `unknown node kind at '${path}'${where}`)
    // A split missing a child is the typical way a wrong removal shows up: half
    // the screen stays empty and the panes below it cannot be reached.
    assert.ok(node.a != null, `split missing child a at '${path}'${where}`)
    assert.ok(node.b != null, `split missing child b at '${path}'${where}`)
    assert.ok(
      Number.isFinite(node.ratio),
      `non-finite ratio (${String(node.ratio)}) at '${path}'${where}`
    )
    assert.ok(
      node.ratio >= MIN_RATIO && node.ratio <= MAX_RATIO,
      `ratio out of bounds (${node.ratio}) at '${path}'${where}`
    )
    visit(node.a, `${path}a`)
    visit(node.b, `${path}b`)
  }

  if (layout.root !== null) visit(layout.root, '')

  const floating = layout.floating.map((f) => f.id)
  const all = [...inTiling, ...floating]

  // A repeated id means two panes on the same terminal.
  assert.equal(
    new Set(all).size,
    all.length,
    `duplicate id among ${JSON.stringify(all)}${where}`
  )

  // Focus must be reachable, otherwise the keyboard types into the void.
  if (layout.focused !== null) {
    assert.ok(
      all.includes(layout.focused),
      `focused points to non-existent '${layout.focused}'${where}`
    )
  }

  // A phantom zoom hides every pane and shows none.
  if (layout.zoomed !== null) {
    assert.ok(
      all.includes(layout.zoomed),
      `zoomed points to non-existent '${layout.zoomed}'${where}`
    )
  }

  // findPath and collectLeaves must tell the same story: dragging and resizing
  // trust the paths.
  for (const id of inTiling) {
    const path = findPath(layout.root, id)
    assert.notEqual(path, null, `findPath did not find '${id}' present in tree${where}`)
    const node = nodeAt(layout.root, path as string)
    assert.deepEqual(node, { kind: 'leaf', id }, `path for '${id}' points elsewhere${where}`)
  }

  for (const f of layout.floating) {
    for (const [field, val] of Object.entries({ x: f.x, y: f.y, w: f.w, h: f.h, z: f.z })) {
      assert.ok(
        Number.isFinite(val),
        `floating pane '${f.id}' has non-finite ${field} (${String(val)})${where}`
      )
    }
  }
}

const RECTANGLE = { x: 100, y: 60, w: 800, h: 400 }

/** Builds a tiling by adding panes one after the other, as the app does. */
function buildTiling(ids: string[], dir: SplitDir = 'h'): Layout {
  let layout: Layout = EMPTY_LAYOUT
  for (const id of ids) layout = addPane(layout, id, dir)
  return layout
}

const SIDES: DropSide[] = ['left', 'right', 'top', 'bottom', 'center']

describe('layout: invariant verification detects corrupted tree', () => {
  // If verifyTree passed on anything, the rest of this file would be green for
  // nothing.
  it('rejects duplicate id, broken split, phantom focus, and NaN ratio', () => {
    const duplicateA: Layout = {
      root: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', id: 'a' }, b: { kind: 'leaf', id: 'a' } },
      floating: [],
      focused: 'a',
      zoomed: null
    }
    assert.throws(() => verifyTree(duplicateA), /duplicate id/)

    const brokenSplit = {
      root: { kind: 'split', dir: 'h', ratio: 0.5, a: { kind: 'leaf', id: 'a' }, b: null },
      floating: [],
      focused: 'a',
      zoomed: null
    } as unknown as Layout
    assert.throws(() => verifyTree(brokenSplit), /missing child b/)

    const phantomFocus: Layout = { root: { kind: 'leaf', id: 'a' }, floating: [], focused: 'b', zoomed: null }
    assert.throws(() => verifyTree(phantomFocus), /focused points/)

    const brokenRatio = {
      root: { kind: 'split', dir: 'h', ratio: NaN, a: { kind: 'leaf', id: 'a' }, b: { kind: 'leaf', id: 'b' } },
      floating: [],
      focused: 'a',
      zoomed: null
    } as unknown as Layout
    assert.throws(() => verifyTree(brokenRatio), /non-finite ratio/)

    // And a healthy tree must not raise false alarms.
    verifyTree(buildTiling(['a', 'b', 'c']))
  })
})

// --- Randomized sequences ---------------------------------------------------

/** Seeded pseudo-random generator: the sequence is always the same. */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Ids that do not exist: every operation must ignore them without touching anything. */
const PHANTOM_IDS = ['phantom', '', 'undefined', 'null', '../../other', 'r999']
/**
 * Plausible paths and garbage paths, like those that can arrive from a drag
 * started before the tree changed.
 */
const PATHS = ['', 'a', 'b', 'ab', 'ba', 'aaa', 'bbbb', 'zz', 'a b', '../..']
/** Including the values a gutter drag produces past the edges. */
const RATIOS = [0, 0.05, 0.25, 0.5, 0.75, 1, 1.5, -3, Infinity, -Infinity]
const OPERATIONS = [
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

interface Outcome {
  changes: Map<string, number>
  maxPanes: number
}

function mixedSequence(seed: number, steps: number, outcome: Outcome): void {
  const rand = prng(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
  const intRange = (max: number): number => Math.floor(rand() * max)

  let layout: Layout = EMPTY_LAYOUT
  let nextId = 0

  for (let step = 0; step < steps; step++) {
    const present = allPanes(layout)
    outcome.maxPanes = Math.max(outcome.maxPanes, present.length)

    // A known id almost always, an invented one now and then.
    const target = (): string =>
      present.length > 0 && rand() < 0.85 ? pick(present) : pick(PHANTOM_IDS)

    const op =
      present.length === 0 || rand() < 0.22 ? 'addPane' : pick(OPERATIONS.filter((o) => o !== 'addPane'))

    const previous = layout
    const snapshot = structuredClone(previous)
    let usedIds: string[] = []

    switch (op) {
      case 'addPane':
        layout = addPane(layout, `r${nextId++}`, pick(['h', 'v'] as SplitDir[]))
        break
      case 'removePane': {
        const id = target()
        usedIds = [id]
        layout = removePane(layout, id)
        break
      }
      case 'setFocus': {
        const id = target()
        usedIds = [id]
        layout = setFocus(layout, id)
        break
      }
      case 'setRatio':
        layout = setRatio(layout, pick(PATHS), pick(RATIOS))
        break
      case 'swapPanes': {
        const a = target()
        const b = target()
        usedIds = [a, b]
        layout = swapPanes(layout, a, b)
        break
      }
      case 'toggleFloat': {
        const id = target()
        usedIds = [id]
        layout = toggleFloat(layout, id, {
          x: intRange(1200),
          y: intRange(700),
          w: 200 + intRange(600),
          h: 150 + intRange(400)
        })
        break
      }
      case 'toggleZoom': {
        const id = target()
        usedIds = [id]
        layout = toggleZoom(layout, id)
        break
      }
      case 'movePaneTo': {
        const a = target()
        const b = target()
        usedIds = [a, b]
        layout = movePaneTo(layout, a, b, pick(SIDES))
        break
      }
      case 'updateFloating': {
        const id = target()
        usedIds = [id]
        layout = updateFloating(layout, id, { x: intRange(1200), y: intRange(700), z: intRange(20) })
        break
      }
    }

    const where = `seed ${seed}, step ${step}, ${op}(${usedIds.join(', ')})`
    verifyTree(layout, where)

    // The functions are declared pure, and the layout ends up in layout.json and
    // in React state: an in-place change would redraw nothing.
    assert.deepEqual(previous, snapshot, `${op} mutated input layout [${where}]`)

    // An id that does not exist must not be able to change anything: this is the
    // case of a session closed while its context menu was still open.
    if (usedIds.length > 0 && usedIds.some((id) => !hasPane(previous, id))) {
      assert.deepEqual(layout, snapshot, `${op} on non-existent id modified layout [${where}]`)
    }

    if (JSON.stringify(layout) !== JSON.stringify(snapshot)) {
      outcome.changes.set(op, (outcome.changes.get(op) ?? 0) + 1)
    }
  }

  // Close everything: nothing may be left at the end, and no step may throw.
  let safety = 0
  while (allPanes(layout).length > 0) {
    layout = removePane(layout, allPanes(layout)[0])
    verifyTree(layout, `seed ${seed}, teardown ${safety}`)
    assert.ok(safety++ < 1000, 'removePane failed to decrease pane count')
  }
  assert.equal(layout.root, null, `seed ${seed}: root did not return to null`)
  assert.equal(layout.focused, null, `seed ${seed}: focus remained on closed pane`)
  assert.equal(layout.zoomed, null, `seed ${seed}: zoom remained on closed pane`)
  assert.deepEqual(layout.floating, [], `seed ${seed}: floating panes remained`)
}

describe('layout: randomized mixed sequences', () => {
  it('maintains invariants after every operation across multiple seeds', () => {
    const outcome: Outcome = { changes: new Map(), maxPanes: 0 }
    for (const seed of [1, 7, 12345, 987654321, 42]) mixedSequence(seed, 400, outcome)

    // The sequence must really have exercised the tree: without these two checks,
    // a change of weights would turn the test green without proving anything.
    assert.ok(outcome.maxPanes >= 6, `tiling too small: ${outcome.maxPanes} panes`)
    for (const op of OPERATIONS) {
      assert.ok((outcome.changes.get(op) ?? 0) > 0, `operation ${op} never produced changes`)
    }
  })
})

// --- Pane closing -----------------------------------------------------------

describe('layout: pane removal', () => {
  it('closing the last pane leaves null root without throwing', () => {
    let layout = buildTiling(['a'])
    layout = removePane(layout, 'a')
    verifyTree(layout, 'after closing last pane')
    assert.equal(layout.root, null)
    assert.equal(layout.focused, null)
  })

  it('closes panes in reverse and arbitrary orders without leaving orphaned splits', () => {
    for (const order of [
      ['a', 'b', 'c', 'd'],
      ['d', 'c', 'b', 'a'],
      ['b', 'd', 'a', 'c'],
      ['c', 'a', 'd', 'b']
    ]) {
      let layout = buildTiling(['a', 'b', 'c', 'd'])
      for (const id of order) {
        layout = removePane(layout, id)
        verifyTree(layout, `closing order ${order.join('')} after ${id}`)
        assert.equal(hasPane(layout, id), false, `${id} still reported present`)
      }
      assert.equal(layout.root, null, `order ${order.join('')}: non-null root`)
      assert.equal(layout.focused, null, `order ${order.join('')}: lingering focus`)
    }
  })

  it('closing last tiled pane does not affect floating panes', () => {
    let layout = buildTiling(['a', 'b'])
    layout = toggleFloat(layout, 'b', RECTANGLE)
    layout = removePane(layout, 'a')
    verifyTree(layout, 'empty tiling with floating pane alive')
    assert.equal(layout.root, null)
    // Focus must fall back on the only pane left, not into the void.
    assert.equal(layout.focused, 'b')
    assert.equal(allPanes(layout).length, 1)
  })

  it('can resume adding panes after closing all', () => {
    let layout = buildTiling(['a', 'b'])
    layout = removePane(layout, 'a')
    layout = removePane(layout, 'b')
    layout = addPane(layout, 'c', 'h')
    verifyTree(layout, 'reopening')
    assert.deepEqual(collectLeaves(layout.root), ['c'])
    assert.equal(layout.focused, 'c')
  })

  it('closing zoomed pane also dismisses zoom', () => {
    let layout = buildTiling(['a', 'b'])
    layout = toggleZoom(layout, 'b')
    assert.equal(layout.zoomed, 'b')
    layout = removePane(layout, 'b')
    // With zoomed on a closed pane the stage would stay black: geometry.ts hides
    // every pane except the zoomed one, which is gone.
    verifyTree(layout, 'closing zoomed pane')
    assert.equal(layout.zoomed, null)
  })
})

// --- setRatio ---------------------------------------------------------------

describe('layout: setRatio boundaries', () => {
  const withSplit = (): Layout => buildTiling(['a', 'b'])

  it('clamps ratio within usable bounds', () => {
    // Past these limits one of the two panes becomes a useless strip: dragging
    // the gutter beyond the edge must simply stop.
    for (const [input, expected] of [
      [0, MIN_RATIO],
      [-0.5, MIN_RATIO],
      [-1000, MIN_RATIO],
      [-Infinity, MIN_RATIO],
      [1, MAX_RATIO],
      [1.5, MAX_RATIO],
      [Infinity, MAX_RATIO],
      [0.42, 0.42]
    ] as [number, number][]) {
      const after = setRatio(withSplit(), '', input)
      const root = after.root as Extract<LayoutNode, { kind: 'split' }>
      assert.equal(root.ratio, expected, `setRatio(${input}) returned ${root.ratio}`)
      verifyTree(after, `setRatio(${input})`)
    }
  })

  it('setRatio with NaN does not break split', () => {
    // Found while writing this suite: the clamp was
    // Math.min(0.9, Math.max(0.1, ratio)), which returns NaN for NaN. The saved
    // ratio became NaN, geometry.ts computed Math.round(usable * NaN) => NaN,
    // both children of the split vanished from the screen, and the value ended up
    // in layout.json too.
    const after = setRatio(withSplit(), '', NaN)
    const root = after.root as Extract<LayoutNode, { kind: 'split' }>
    assert.ok(Number.isFinite(root.ratio), `ratio became ${root.ratio}`)
  })

  it('ignores paths that do not lead to a split', () => {
    const singleLeaf = buildTiling(['a'])
    assert.deepEqual(setRatio(singleLeaf, '', 0.3), singleLeaf)
    assert.deepEqual(setRatio(EMPTY_LAYOUT, '', 0.3), EMPTY_LAYOUT)

    const two = withSplit()
    // A path deeper than the tree: it happens when a gutter drag goes on after
    // the pane below was closed.
    for (const path of ['a', 'b', 'aaa', 'bbbbbb']) {
      assert.deepEqual(setRatio(two, path, 0.3), two, `path '${path}'`)
    }
  })

  it('invalid path does not resize another split', () => {
    // Found while writing this suite: nodeAt and replaceAt treated every
    // character other than 'a' as 'b' (step === 'a' ? a : b). A path the app never
    // emits, such as 'z', was followed down to child b and changed its ratio: the
    // request was not rejected, it resized another split.
    const layout = buildTiling(['a', 'b', 'c'])
    assert.deepEqual(setRatio(layout, 'z', 0.3), layout)
  })

  it('modifies only targeted split', () => {
    const layout = buildTiling(['a', 'b', 'c'])
    const after = setRatio(layout, 'b', 0.25)
    const root = after.root as Extract<LayoutNode, { kind: 'split' }>
    assert.equal(root.ratio, 0.5, 'root split should remain unchanged')
    assert.equal((root.b as Extract<LayoutNode, { kind: 'split' }>).ratio, 0.25)
    verifyTree(after, 'targeted setRatio')
  })
})

// --- movePaneTo -------------------------------------------------------------

describe('layout: movePaneTo (drag & drop)', () => {
  it('inserts pane at correct side without duplication', () => {
    // The order of the leaves is the order on screen: getting it wrong means
    // dropping on the left and seeing the pane appear on the right.
    const cases: [DropSide, string[], SplitDir][] = [
      ['left', ['c', 'a', 'b'], 'h'],
      ['right', ['a', 'c', 'b'], 'h'],
      ['top', ['c', 'a', 'b'], 'v'],
      ['bottom', ['a', 'c', 'b'], 'v']
    ]
    for (const [side, expected, dir] of cases) {
      const after = movePaneTo(buildTiling(['a', 'b', 'c']), 'c', 'a', side)
      verifyTree(after, `movePaneTo ${side}`)
      assert.deepEqual(collectLeaves(after.root), expected, `side ${side}`)
      const newNode = nodeAt(after.root, 'a') as Extract<LayoutNode, { kind: 'split' }>
      assert.equal(newNode.kind, 'split', `side ${side}: no split created`)
      assert.equal(newNode.dir, dir, `side ${side}: wrong direction`)
      assert.equal(after.focused, 'c', `side ${side}: focus should follow dragged pane`)
    }
  })

  it('center drop side swaps the two panes without duplicating', () => {
    const after = movePaneTo(buildTiling(['a', 'b', 'c']), 'a', 'c', 'center')
    verifyTree(after, 'movePaneTo center')
    assert.deepEqual(collectLeaves(after.root), ['c', 'b', 'a'])
    assert.equal(after.focused, 'a')
  })

  it('dropping a pane onto itself does nothing', () => {
    const layout = buildTiling(['a', 'b', 'c'])
    for (const side of SIDES) {
      assert.deepEqual(movePaneTo(layout, 'b', 'b', side), layout, `side ${side}`)
    }
  })

  it('ignores non-existent ids on either side', () => {
    const layout = buildTiling(['a', 'b'])
    for (const side of SIDES) {
      assert.deepEqual(movePaneTo(layout, 'phantom', 'a', side), layout, `unknown source, ${side}`)
      assert.deepEqual(movePaneTo(layout, 'a', 'phantom', side), layout, `unknown target, ${side}`)
      assert.deepEqual(movePaneTo(layout, 'x', 'y', side), layout, `both unknown, ${side}`)
    }
  })

  it('with single pane move does nothing', () => {
    const layout = buildTiling(['a'])
    for (const side of SIDES) {
      assert.deepEqual(movePaneTo(layout, 'a', 'a', side), layout, `side ${side}`)
      assert.deepEqual(movePaneTo(layout, 'a', 'b', side), layout, `side ${side}, missing target`)
      verifyTree(movePaneTo(layout, 'a', 'a', side), `single pane, ${side}`)
    }
  })

  it('dragging only tiled pane onto floating pane does not lose it', () => {
    // Without the check on detached.root the tiling would stay empty and the
    // dragged pane would land nowhere: a lost session.
    let layout = buildTiling(['a', 'b'])
    layout = toggleFloat(layout, 'b', RECTANGLE)
    const after = movePaneTo(layout, 'a', 'b', 'left')
    verifyTree(after, 'only pane toward floating')
    assert.equal(hasPane(after, 'a'), true)
    assert.equal(hasPane(after, 'b'), true)
  })

  it('dragging floating pane into tiling docks it cleanly', () => {
    let layout = buildTiling(['a', 'b', 'c'])
    layout = toggleFloat(layout, 'c', RECTANGLE)
    const after = movePaneTo(layout, 'c', 'a', 'right')
    verifyTree(after, 'floating redocked by drag')
    assert.equal(isFloating(after, 'c'), false)
    assert.deepEqual(after.floating, [])
    assert.deepEqual(collectLeaves(after.root), ['a', 'c', 'b'])
    assert.equal(after.focused, 'c')
  })

  it('center swap is disabled for floating panes', () => {
    // A floating pane holds no position in the tree: swapping it would duplicate
    // it or make it vanish.
    let layout = buildTiling(['a', 'b'])
    layout = toggleFloat(layout, 'b', RECTANGLE)
    assert.deepEqual(movePaneTo(layout, 'b', 'a', 'center'), layout)
    assert.deepEqual(movePaneTo(layout, 'a', 'b', 'center'), layout)
  })

  it('repeated drags neither multiply nor lose panes', () => {
    let layout = buildTiling(['a', 'b', 'c', 'd'])
    const expected = ['a', 'b', 'c', 'd']
    let i = 0
    for (const src of expected) {
      for (const dst of expected) {
        const side = SIDES[i++ % SIDES.length]
        layout = movePaneTo(layout, src, dst, side)
        verifyTree(layout, `${src} -> ${dst} (${side})`)
        assert.deepEqual([...allPanes(layout)].sort(), expected, `after ${src} -> ${dst}`)
      }
    }
  })
})

// --- Floating panes ---------------------------------------------------------

describe('layout: floating panes', () => {
  it('repeatedly detaching and docking preserves pane set', () => {
    let layout = buildTiling(['a', 'b', 'c'])
    const expected = ['a', 'b', 'c']

    for (let round = 0; round < 40; round++) {
      layout = toggleFloat(layout, 'c', RECTANGLE)
      verifyTree(layout, `round ${round}, detached`)
      assert.equal(isFloating(layout, 'c'), true, `round ${round}: should be floating`)
      assert.equal(layout.focused, 'c')
      assert.deepEqual([...allPanes(layout)].sort(), expected, `round ${round}, detached`)

      layout = toggleFloat(layout, 'c', RECTANGLE)
      verifyTree(layout, `round ${round}, redocked`)
      assert.equal(isFloating(layout, 'c'), false, `round ${round}: should return to tiling`)
      assert.equal(layout.focused, 'c')
      assert.deepEqual([...allPanes(layout)].sort(), expected, `round ${round}, redocked`)
    }
  })

  it('detaching only pane empties tiling without losing session', () => {
    let layout = buildTiling(['a'])
    layout = toggleFloat(layout, 'a', RECTANGLE)
    verifyTree(layout, 'single pane detached')
    assert.equal(layout.root, null)
    assert.deepEqual(allPanes(layout), ['a'])
    assert.equal(layout.focused, 'a')

    layout = toggleFloat(layout, 'a', RECTANGLE)
    verifyTree(layout, 'single pane redocked')
    assert.deepEqual(collectLeaves(layout.root), ['a'])
    assert.deepEqual(layout.floating, [])
  })

  it('focused floating pane raises to top z-index', () => {
    let layout = buildTiling(['a', 'b', 'c'])
    layout = toggleFloat(layout, 'b', RECTANGLE)
    layout = toggleFloat(layout, 'c', RECTANGLE)

    const zIndex = (l: Layout, id: string): number => l.floating.find((f) => f.id === id)!.z
    assert.ok(zIndex(layout, 'c') > zIndex(layout, 'b'), 'last detached pane should be on top')

    layout = setFocus(layout, 'b')
    verifyTree(layout, 'focus on floating pane')
    // Without raising it, the active pane would stay covered and you would type
    // blind into a terminal you cannot see.
    assert.ok(zIndex(layout, 'b') > zIndex(layout, 'c'), 'active floating pane should raise to top')
  })

  it('detaching zoomed pane dismisses zoom', () => {
    let layout = buildTiling(['a', 'b'])
    layout = toggleZoom(layout, 'a')
    layout = toggleFloat(layout, 'a', RECTANGLE)
    verifyTree(layout, 'detached while zoomed')
    assert.equal(layout.zoomed, null)
  })

  it('updateFloating touches only targeted pane and ignores unknown ids', () => {
    let layout = buildTiling(['a', 'b'])
    layout = toggleFloat(layout, 'a', RECTANGLE)
    layout = toggleFloat(layout, 'b', RECTANGLE)

    const moved = updateFloating(layout, 'a', { x: 12, y: 34 })
    verifyTree(moved, 'updateFloating')
    assert.deepEqual(
      moved.floating.find((f) => f.id === 'a'),
      { ...layout.floating.find((f) => f.id === 'a')!, x: 12, y: 34 }
    )
    assert.deepEqual(moved.floating.find((f) => f.id === 'b'), layout.floating.find((f) => f.id === 'b'))
    assert.deepEqual(updateFloating(layout, 'phantom', { x: 1 }), layout)
  })
})

// --- Focus & Zoom -----------------------------------------------------------

describe('layout: focus and zoom', () => {
  it('focus never shifts to a non-existent pane', () => {
    const layout = buildTiling(['a', 'b'])
    for (const id of ['phantom', '', 'A', 'aa']) {
      const after = setFocus(layout, id)
      assert.deepEqual(after, layout, `setFocus('${id}')`)
      verifyTree(after, `setFocus('${id}')`)
    }
  })

  it('closing active pane shifts focus to an existing pane', () => {
    let layout = buildTiling(['a', 'b', 'c'])
    layout = setFocus(layout, 'b')
    layout = removePane(layout, 'b')
    verifyTree(layout, 'closing active pane')
    assert.notEqual(layout.focused, null)
    assert.equal(hasPane(layout, layout.focused as string), true)
  })

  it('closing non-active pane preserves focus', () => {
    let layout = buildTiling(['a', 'b', 'c'])
    layout = setFocus(layout, 'a')
    layout = removePane(layout, 'c')
    assert.equal(layout.focused, 'a')
    verifyTree(layout, 'closing inactive pane')
  })

  it('toggleZoom ignores unknown ids and toggles off on repeat', () => {
    const layout = buildTiling(['a', 'b'])
    assert.deepEqual(toggleZoom(layout, 'phantom'), layout)
    const on = toggleZoom(layout, 'a')
    assert.equal(on.zoomed, 'a')
    assert.equal(toggleZoom(on, 'a').zoomed, null)
    // Zooming another pane replaces the zoom, it does not add one.
    assert.equal(toggleZoom(on, 'b').zoomed, 'b')
  })
})

// --- swapPanes --------------------------------------------------------------

describe('layout: swapPanes', () => {
  it('swaps positions without modifying pane set', () => {
    const layout = buildTiling(['a', 'b', 'c'])
    const after = swapPanes(layout, 'a', 'c')
    verifyTree(after, 'swapPanes')
    assert.deepEqual(collectLeaves(after.root), ['c', 'b', 'a'])
    // Two swaps bring back the starting state: position is the only thing that
    // changes.
    assert.deepEqual(swapPanes(after, 'a', 'c'), layout)
  })

  it('does nothing on self, unknown ids, or floating pane', () => {
    let layout = buildTiling(['a', 'b', 'c'])
    assert.deepEqual(swapPanes(layout, 'a', 'a'), layout)
    assert.deepEqual(swapPanes(layout, 'a', 'phantom'), layout)
    assert.deepEqual(swapPanes(layout, 'phantom', 'a'), layout)
    layout = toggleFloat(layout, 'c', RECTANGLE)
    assert.deepEqual(swapPanes(layout, 'a', 'c'), layout)
  })
})

// --- EMPTY_LAYOUT -----------------------------------------------------------

describe('layout: operations on empty layout', () => {
  const EMPTY = { root: null, floating: [], focused: null, zoomed: null }

  it('no operation throws or manufactures panes', () => {
    const results: Layout[] = [
      removePane(EMPTY_LAYOUT, 'a'),
      setFocus(EMPTY_LAYOUT, 'a'),
      setRatio(EMPTY_LAYOUT, '', 0.5),
      setRatio(EMPTY_LAYOUT, 'ab', NaN),
      swapPanes(EMPTY_LAYOUT, 'a', 'b'),
      toggleFloat(EMPTY_LAYOUT, 'a', RECTANGLE),
      toggleZoom(EMPTY_LAYOUT, 'a'),
      updateFloating(EMPTY_LAYOUT, 'a', { x: 1 })
    ]
    for (const side of SIDES) results.push(movePaneTo(EMPTY_LAYOUT, 'a', 'b', side))

    for (const [i, r] of results.entries()) {
      verifyTree(r, `empty layout, result ${i}`)
      assert.deepEqual(r, EMPTY, `result ${i}`)
      assert.deepEqual(allPanes(r), [], `result ${i}`)
    }
  })

  it('first pane becomes root and is focused', () => {
    const after = addPane(EMPTY_LAYOUT, 'a', 'h')
    verifyTree(after, 'first pane')
    assert.deepEqual(after.root, { kind: 'leaf', id: 'a' })
    assert.equal(after.focused, 'a')
  })

  it('EMPTY_LAYOUT remains empty and immutable', () => {
    // It is an exported constant: if a function changed it in place, every later
    // launch would start with the panes of the previous session.
    assert.deepEqual(EMPTY_LAYOUT, EMPTY)
  })
})
