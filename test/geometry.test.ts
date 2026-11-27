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

/** Reference stage: a maximized window on a standard display. */
const STAGE: Rect = { x: 0, y: 0, w: 1600, h: 900 }

/**
 * Private constants from geometry.ts, intentionally duplicated here.
 * If someone lowers them, visibility tests should catch it rather than
 * quietly adjusting.
 */
const MIN_VISIBLE = 80
const HEADER_VISIBLE = 30

function compute(layout: Layout, stage: Rect = STAGE): ComputedLayout {
  return computeLayout(layout, stage)
}

function rectOf(layout: Layout, id: string, stage: Rect = STAGE): PaneLayout | null {
  return compute(layout, stage).panes.find((p) => p.id === id) ?? null
}

/** Only tiled panes: floating panes by definition overlap. */
function tiled(c: ComputedLayout): PaneLayout[] {
  return c.panes.filter((p) => !p.floating)
}

function doOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** App convention: wide pane splits horizontally, tall pane splits vertically. */
function naturalSplitDir(rect: { w: number; h: number } | null): SplitDir {
  return !rect || rect.w >= rect.h ? 'h' : 'v'
}

/** Tiling of n panes, repeatedly splitting the focused pane as the app does. */
function tiling(n: number, stage: Rect = STAGE): Layout {
  let layout = EMPTY_LAYOUT
  for (let i = 1; i <= n; i++) {
    const active = layout.focused ? rectOf(layout, layout.focused, stage) : null
    layout = addPane(layout, `p${i}`, naturalSplitDir(active))
  }
  return layout
}

/**
 * Regression test for issue #10.
 *
 * Previously no minimum dimension was enforced. Repeatedly splitting the same
 * pane gave widths of 1600, 796, 394, 193, 92, 42, 17, 4 and finally 0: from
 * the 8th split onward the pane was born zero wide. The session really started
 * and consumed tokens, but the terminal was neither visible nor reachable with
 * the mouse, and the only way to notice was the bill.
 */
describe('geometry: minimum pane dimension (issue #10)', () => {
  it('without guard the 8th split still produces a zero-width pane', () => {
    // The original defect, reproduced: it is the reason canSplit exists.
    let layout = EMPTY_LAYOUT
    for (let i = 1; i <= 9; i++) layout = addPane(layout, `p${i}`, 'h')

    const widths = tiled(compute(layout)).map((p) => p.w)
    assert.equal(widths.length, 9)
    assert.equal(Math.min(...widths), 0, 'historical sequence is no longer reproduced')
  })

  it('canSplit rejects before space runs out', () => {
    // 4th pane in sequence is 193 wide: guard must reject here well before 0.
    assert.equal(canSplit({ w: 193, h: 900 }, 'h'), false)

    // Exact boundary: 288 = 140 + 8 + 140, smallest permitted split.
    assert.equal(canSplit({ w: 288, h: 900 }, 'h'), true)
    assert.equal(canSplit({ w: 287, h: 900 }, 'h'), false)
    assert.equal(canSplit({ w: 1600, h: 188 }, 'v'), true)
    assert.equal(canSplit({ w: 1600, h: 187 }, 'v'), false)

    // Unmeasured or degenerate stage must never permit split.
    assert.equal(canSplit({ w: 0, h: 0 }, 'h'), false)
    assert.equal(canSplit({ w: 0, h: 0 }, 'v'), false)
    assert.equal(canSplit({ w: -1600, h: -900 }, 'h'), false)
    assert.equal(canSplit({ w: -1600, h: -900 }, 'v'), false)
  })

  it('canSplit returns true exactly when actual split stays above threshold', () => {
    // The guard must be neither wider (unusable panes) nor narrower (splits
    // refused for no reason) than the split that then happens.
    const twoHorizontal = addPane(addPane(EMPTY_LAYOUT, 'a', 'h'), 'b', 'h')
    for (let w = 0; w <= 600; w++) {
      const widths = tiled(compute(twoHorizontal, { x: 0, y: 0, w, h: 900 })).map((p) => p.w)
      const aboveThreshold = Math.min(...widths) >= MIN_PANE_W
      assert.equal(canSplit({ w, h: 900 }, 'h'), aboveThreshold, `width ${w}`)
    }

    const twoVertical = addPane(addPane(EMPTY_LAYOUT, 'a', 'v'), 'b', 'v')
    for (let h = 0; h <= 400; h++) {
      const heights = tiled(compute(twoVertical, { x: 0, y: 0, w: 1600, h })).map((p) => p.h)
      const aboveThreshold = Math.min(...heights) >= MIN_PANE_H
      assert.equal(canSplit({ w: 1600, h }, 'v'), aboveThreshold, `height ${h}`)
    }
  })

  it('splitting while canSplit allows ensures no pane drops below threshold', () => {
    let layout = EMPTY_LAYOUT
    let splits = 0
    const maxSplits = 500

    while (splits < maxSplits) {
      const active = layout.focused ? rectOf(layout, layout.focused) : null
      const dir = naturalSplitDir(active)
      // The same condition as the app: when the guard says no, the session is born
      // floating, not inside an invisible pane.
      if (active && !canSplit(active, dir)) break
      layout = addPane(layout, `p${splits + 1}`, dir)
      splits++
    }

    assert.ok(splits > 1, 'no splits allowed on 1600x900 stage')
    assert.ok(splits < maxSplits, 'guard never stopped splits')

    for (const p of tiled(compute(layout))) {
      assert.ok(p.w >= MIN_PANE_W, `${p.id} width ${p.w}, below ${MIN_PANE_W}`)
      assert.ok(p.h >= MIN_PANE_H, `${p.id} height ${p.h}, below ${MIN_PANE_H}`)
    }
  })

  it('pane just above threshold splits into two usable panes', () => {
    // The edge case matters more than the others: it is where the guard decides.
    const tight: Rect = { x: 0, y: 0, w: MIN_PANE_W * 2 + GAP, h: MIN_PANE_H * 2 + GAP }
    assert.equal(canSplit(tight, 'h'), true)
    assert.equal(canSplit(tight, 'v'), true)

    const split = addPane(addPane(EMPTY_LAYOUT, 'a', 'h'), 'b', 'h')
    for (const p of tiled(compute(split, tight))) {
      assert.equal(p.w, MIN_PANE_W)
      assert.equal(p.h, tight.h)
    }
  })
})

describe('geometry: tiling invariants', () => {
  for (const n of [1, 2, 3, 5, 9]) {
    it(`with ${n} panes rectangles do not overlap and fit inside stage`, () => {
      const panes = tiled(compute(tiling(n)))
      assert.equal(panes.length, n)

      for (const p of panes) {
        for (const val of [p.x, p.y, p.w, p.h]) {
          assert.ok(Number.isFinite(val), `${p.id} has non-finite coordinate`)
        }
        assert.ok(p.w >= 0 && p.h >= 0, `${p.id} has negative dimension: ${p.w}x${p.h}`)
        assert.ok(p.x >= STAGE.x, `${p.id} overflows left`)
        assert.ok(p.y >= STAGE.y, `${p.id} overflows top`)
        assert.ok(p.x + p.w <= STAGE.x + STAGE.w, `${p.id} overflows right`)
        assert.ok(p.y + p.h <= STAGE.y + STAGE.h, `${p.id} overflows bottom`)
      }

      for (let i = 0; i < panes.length; i++) {
        for (let j = i + 1; j < panes.length; j++) {
          assert.ok(
            !doOverlap(panes[i], panes[j]),
            `${panes[i].id} and ${panes[j].id} overlap each other`
          )
        }
      }
    })
  }

  it('uses full stage: panes only leave gutters', () => {
    // A rounding error would leave a permanent dead strip.
    const panes = tiled(compute(tiling(2)))
    const area = panes.reduce((sum, p) => sum + p.w * p.h, 0)
    assert.equal(area, (STAGE.w - GAP) * STAGE.h)
  })

  it('offset stage is not treated as if at origin', () => {
    // The window has a toolbar on top: if the offset is lost, the panes end up
    // under it.
    const offset: Rect = { x: 120, y: 48, w: 1000, h: 700 }
    for (const p of tiled(compute(tiling(5, offset), offset))) {
      assert.ok(p.x >= offset.x && p.y >= offset.y, `${p.id} goes beyond stage bounds`)
      assert.ok(p.x + p.w <= offset.x + offset.w && p.y + p.h <= offset.y + offset.h)
    }
  })

  for (const degenerate of [
    { x: 0, y: 0, w: 0, h: 0 },
    { x: 0, y: 0, w: 0, h: 900 },
    { x: 0, y: 0, w: 1600, h: 0 },
    { x: 0, y: 0, w: -1600, h: -900 }
  ]) {
    it(`degenerate stage ${degenerate.w}x${degenerate.h} does not produce invalid numbers`, () => {
      // It really happens: the window gets minimized and the container measures
      // zero. One NaN here and nothing comes back when it is restored.
      const c = compute(tiling(3, STAGE), degenerate)
      const panes = tiled(c)
      assert.equal(panes.length, 3)

      for (const p of panes) {
        for (const val of [p.x, p.y, p.w, p.h]) {
          assert.ok(Number.isFinite(val), `${p.id}: non-finite coordinate`)
        }
        // No pane can be bigger than the available space.
        assert.ok(p.w <= Math.max(0, degenerate.w), `${p.id} width ${p.w} on stage ${degenerate.w}`)
        assert.ok(p.h <= Math.max(0, degenerate.h), `${p.id} height ${p.h} on stage ${degenerate.h}`)
      }

      for (const g of c.gutters) {
        for (const val of [g.x, g.y, g.w, g.h]) {
          assert.ok(Number.isFinite(val), 'gutter with non-finite coordinate')
        }
      }
    })
  }
})

describe('geometry: floating panes off-screen', () => {
  /** A tiling of two panes where the second one has been detached. */
  function withFloating(patch: { x: number; y: number; w: number; h: number }): Layout {
    const base = tiling(2)
    const rect = rectOf(base, 'p2')
    assert.ok(rect)
    return updateFloating(toggleFloat(base, 'p2', rect), 'p2', patch)
  }

  const cases = [
    { name: 'far right, from wider display', x: 5000, y: 200, w: 400, h: 300 },
    { name: 'far left, negative coordinates', x: -5000, y: 100, w: 400, h: 300 },
    { name: 'below bottom edge', x: 300, y: 4000, w: 400, h: 300 },
    { name: 'above top edge', x: 300, y: -4000, w: 400, h: 300 },
    { name: 'past bottom-right corner', x: 9999, y: 9999, w: 400, h: 300 },
    { name: 'larger than stage', x: -200, y: -200, w: 5000, h: 4000 },
    { name: 'tiny and off-screen', x: 9999, y: 9999, w: 10, h: 10 }
  ]

  for (const c of cases) {
    it(`remains clamped with visible portion: ${c.name}`, () => {
      // The saved coordinates come from an earlier session, perhaps on another
      // monitor. Without snapping back, the pane exists but cannot be seen, nor
      // brought back with the mouse.
      const p = rectOf(withFloating(c), 'p2')
      assert.ok(p)
      assert.equal(p.floating, true)

      for (const val of [p.x, p.y, p.w, p.h]) {
        assert.ok(Number.isFinite(val), 'non-finite coordinate')
      }
      assert.ok(p.w > 0 && p.h > 0, `degenerate floating pane ${p.w}x${p.h}`)
      assert.ok(p.w <= STAGE.w && p.h <= STAGE.h, 'floating pane larger than stage')

      const visibleX = Math.min(p.x + p.w, STAGE.x + STAGE.w) - Math.max(p.x, STAGE.x)
      const visibleY = Math.min(p.y + p.h, STAGE.y + STAGE.h) - Math.max(p.y, STAGE.y)
      assert.ok(
        visibleX >= Math.min(p.w, MIN_VISIBLE),
        `only ${visibleX} px visible horizontally`
      )
      assert.ok(
        visibleY >= Math.min(p.h, HEADER_VISIBLE),
        `only ${visibleY} px visible vertically: header cannot be grabbed`
      )
    })
  }

  it('header remains grab-able even on offset stage', () => {
    // The title bar is the only way to drag a floating pane back: it must stay
    // below the top edge of the stage, not above it.
    const offset: Rect = { x: 200, y: 90, w: 900, h: 600 }
    const layout = withFloating({ x: -9999, y: -9999, w: 400, h: 300 })
    const p = rectOf(layout, 'p2', offset)
    assert.ok(p)
    assert.ok(p.y >= offset.y, 'header ended up above stage top edge')
    assert.ok(p.x + p.w >= offset.x + MIN_VISIBLE, 'nothing grab-able on left')
  })

  it('floating pane sits above tiling', () => {
    const layout = withFloating({ x: 100, y: 100, w: 400, h: 300 })
    const c = compute(layout)
    const floatPane = c.panes.find((p) => p.floating)
    assert.ok(floatPane)
    for (const p of tiled(c)) assert.ok(floatPane.z > p.z, 'floating pane rendered below tiling')
  })
})

describe('geometry: drag drop side detection', () => {
  const wideRects: Rect[] = [
    { x: 0, y: 0, w: 1000, h: 600 },
    // Very wide and short: without normalizing, the top and bottom edges would
    // be unreachable, and docking above or below would no longer be possible.
    { x: 0, y: 0, w: 1200, h: 60 },
    // Very narrow and tall: the mirror case.
    { x: 0, y: 0, w: 60, h: 1200 },
    // With an offset: the rectangle is almost never at the origin.
    { x: 340, y: 120, w: 500, h: 300 }
  ]

  for (const r of wideRects) {
    it(`four edges and center of ${r.w}x${r.h} return correct side`, () => {
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      assert.equal(dropSideAt(r, { x: r.x + 1, y: cy }), 'left')
      assert.equal(dropSideAt(r, { x: r.x + r.w - 1, y: cy }), 'right')
      assert.equal(dropSideAt(r, { x: cx, y: r.y + 1 }), 'top')
      assert.equal(dropSideAt(r, { x: cx, y: r.y + r.h - 1 }), 'bottom')
      assert.equal(dropSideAt(r, { x: cx, y: cy }), 'center')
    })

    it(`four corners of ${r.w}x${r.h} are not mistaken for center`, () => {
      // On a corner the choice between the two adjacent sides is debatable, but
      // swapping the panes when pointing at a corner never is.
      const corners = [
        { p: { x: r.x + 1, y: r.y + 1 }, allowed: ['left', 'top'] },
        { p: { x: r.x + r.w - 1, y: r.y + 1 }, allowed: ['right', 'top'] },
        { p: { x: r.x + 1, y: r.y + r.h - 1 }, allowed: ['left', 'bottom'] },
        { p: { x: r.x + r.w - 1, y: r.y + r.h - 1 }, allowed: ['right', 'bottom'] }
      ]
      for (const { p, allowed } of corners) {
        const side = dropSideAt(r, p)
        assert.ok(allowed.includes(side), `corner ${p.x},${p.y} returned ${side}`)
      }
    })
  }

  it('center drop zone is small and symmetrical', () => {
    // If the center were wide, panes would be swapped when the user meant to dock
    // them side by side. Just past a fifth from the center it must already dock.
    const r: Rect = { x: 0, y: 0, w: 1000, h: 1000 }
    assert.equal(dropSideAt(r, { x: 500 + 200, y: 500 }), 'center')
    assert.equal(dropSideAt(r, { x: 500 + 230, y: 500 }), 'right')
    assert.equal(dropSideAt(r, { x: 500 - 230, y: 500 }), 'left')
    assert.equal(dropSideAt(r, { x: 500, y: 500 - 230 }), 'top')
    assert.equal(dropSideAt(r, { x: 500, y: 500 + 230 }), 'bottom')
  })

  it('degenerate rectangle does not break calculation', () => {
    // It happens while the layout is still being measured: it must give a valid
    // answer instead of NaN or an invented side.
    for (const r of [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: 1, h: 0 },
      { x: 0, y: 0, w: -10, h: -10 }
    ]) {
      const side = dropSideAt(r, { x: 0, y: 0 })
      assert.ok(['left', 'right', 'top', 'bottom', 'center'].includes(side))
    }
  })

  it('every interior point receives exactly one valid drop side', () => {
    const r: Rect = { x: 10, y: 20, w: 333, h: 177 }
    for (let x = r.x; x <= r.x + r.w; x += 7) {
      for (let y = r.y; y <= r.y + r.h; y += 7) {
        const side = dropSideAt(r, { x, y })
        assert.ok(
          ['left', 'right', 'top', 'bottom', 'center'].includes(side),
          `point ${x},${y} without side`
        )
      }
    }
  })
})

describe('geometry: focus movement across panes', () => {
  /**
   * Known 2x2 grid:
   *   p1 p2
   *   p3 p4
   */
  function grid(): Layout {
    let layout = addPane(EMPTY_LAYOUT, 'p1', 'h')
    layout = addPane(layout, 'p2', 'h') // p1 | p2
    layout = addPane(setFocus(layout, 'p1'), 'p3', 'v') // p1 above p3
    layout = addPane(setFocus(layout, 'p2'), 'p4', 'v') // p2 above p4
    return layout
  }

  const neighbors: [string, 'left' | 'right' | 'up' | 'down', string | null][] = [
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

  for (const [from, dir, expected] of neighbors) {
    it(`from ${from} toward ${dir} leads to ${expected ?? 'no pane'}`, () => {
      // Toward the outside it must give null: focus must not jump to the other side
      // of the screen when you are already at the edge.
      const panes = compute(grid()).panes
      assert.equal(paneInDirection(panes, from, dir), expected)
    })
  }

  it('prefers collinear neighbor over closer diagonal neighbor', () => {
    /**
     * An arrangement chosen on purpose so that the two criteria disagree:
     *
     *   pA      |        pC        (top row)
     *   p1 |          pB           (bottom row)
     *
     * The center of pA is ~456 px from p1's, pB's is ~804: by raw distance pA
     * would win, but pA is ABOVE. Pressing "right" must land on pB, and pressing
     * "up" on pA.
     */
    let layout = addPane(EMPTY_LAYOUT, 'pA', 'h')
    layout = addPane(layout, 'p1', 'v')
    layout = addPane(setFocus(layout, 'pA'), 'pC', 'h')
    layout = addPane(setFocus(layout, 'p1'), 'pB', 'h')
    layout = setRatio(layout, 'a', 0.25)
    layout = setRatio(layout, 'b', 0.2)

    const panes = compute(layout).panes
    const p1 = panes.find((q) => q.id === 'p1')
    assert.ok(p1)
    const distFromP1 = (id: string): number => {
      const p = panes.find((q) => q.id === id)
      assert.ok(p)
      return Math.hypot(p.x + p.w / 2 - (p1.x + p1.w / 2), p.y + p.h / 2 - (p1.y + p1.h / 2))
    }
    assert.ok(
      distFromP1('pA') < distFromP1('pB'),
      'layout puts the two criteria in conflict'
    )

    assert.equal(paneInDirection(panes, 'p1', 'right'), 'pB')
    assert.equal(paneInDirection(panes, 'p1', 'up'), 'pA')
  })

  it('non-existent pane does not move focus', () => {
    const panes = compute(grid()).panes
    assert.equal(paneInDirection(panes, 'phantom', 'right'), null)
  })

  it('single pane has no neighbors in any direction', () => {
    const panes = compute(tiling(1)).panes
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      assert.equal(paneInDirection(panes, 'p1', dir), null)
    }
  })
})

describe('geometry: zoomed pane', () => {
  it('when zoom is active only zoomed pane is visible', () => {
    const base = tiling(5)
    const rect = rectOf(base, 'p5')
    assert.ok(rect)
    // Even a floating pane, which normally covers everything, must disappear
    // under the zoom.
    const withFloat = toggleFloat(base, 'p5', { x: 200, y: 200, w: 500, h: 400 })
    const c = compute(toggleZoom(withFloat, 'p3'))

    const visible = c.panes.filter((p) => !p.hidden)
    assert.deepEqual(
      visible.map((p) => p.id),
      ['p3']
    )

    const zoom = visible[0]
    assert.deepEqual({ x: zoom.x, y: zoom.y, w: zoom.w, h: zoom.h }, STAGE)
    for (const p of c.panes) {
      if (p.id !== 'p3') assert.ok(zoom.z > p.z, `${p.id} stays above zoomed pane`)
    }
    // With no visible tiling there is nothing to resize: a draggable gutter over
    // the zoom would change a layout nobody can see.
    assert.deepEqual(c.gutters, [])
  })

  it('hidden panes retain full dimensions', () => {
    // Zeroing them would resize the PTY, and on leaving the zoom the terminal
    // content would already have been reflowed for nothing.
    const withoutZoom = compute(tiling(4))
    const withZoom = compute(toggleZoom(tiling(4), 'p2'))

    for (const before of tiled(withoutZoom)) {
      if (before.id === 'p2') continue
      const after = withZoom.panes.find((p) => p.id === before.id)
      assert.ok(after)
      assert.equal(after.hidden, true)
      assert.equal(after.w, before.w)
      assert.equal(after.h, before.h)
    }
  })

  it('focus does not move to a pane hidden by zoom', () => {
    // With a single visible pane, the arrow keys must not lead into a terminal
    // the user cannot see.
    const c = compute(toggleZoom(tiling(4), 'p2'))
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      assert.equal(paneInDirection(c.panes, 'p2', dir), null)
    }
  })

  it('removing zoom restores all panes in place', () => {
    const layout = tiling(4)
    const before = compute(layout)
    const after = compute(toggleZoom(toggleZoom(layout, 'p2'), 'p2'))
    assert.deepEqual(after, before)
  })
})
