import type { Direction, DropSide, Layout, LayoutNode, SplitDir } from './layout'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PaneLayout extends Rect {
  id: string
  floating: boolean
  /** Hidden because another pane is zoomed. Retains full dimensions
   *  to avoid triggering an unnecessary PTY resize that would have to be undone. */
  hidden: boolean
  z: number
}

export interface GutterLayout extends Rect {
  /** Path of split node to adjust during drag. */
  path: string
  dir: SplitDir
}

/** Width of the gutter between two panes; hit area is larger. */
export const GAP = 8
const GUTTER_HIT = 5
/** Floating pane strip that must always remain visible within stage. */
const MIN_VISIBLE = 80
const HEADER_VISIBLE = 30

/**
 * Below these dimensions, a terminal is no longer usable.
 *
 * Previously there was no limit: repeated splits in the same direction
 * yielded widths 1600, 796, 394, 193, 92, 42, 17, 4, 0. By the eighth split,
 * the pane spawned with width 0 — the process launched and consumed tokens,
 * but was invisible and unreachable with the mouse.
 *
 * 140x90 is approximately 16 columns by 5 rows: narrow, but still readable.
 */
export const MIN_PANE_W = 140
export const MIN_PANE_H = 90

/** True if the pane has enough space to be split in that direction. */
export function canSplit(rect: { w: number; h: number }, dir: 'h' | 'v'): boolean {
  return dir === 'h'
    ? (rect.w - GAP) / 2 >= MIN_PANE_W
    : (rect.h - GAP) / 2 >= MIN_PANE_H
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface ComputedLayout {
  panes: PaneLayout[]
  gutters: GutterLayout[]
}

export function computeLayout(layout: Layout, stage: Rect): ComputedLayout {
  const panes: PaneLayout[] = []
  const gutters: GutterLayout[] = []

  if (layout.root) walk(layout.root, stage, '', panes, gutters)

  for (const f of layout.floating) {
    // Persisted coordinates may come from a larger monitor: without clamping
    // them inside stage bounds, a restored pane would sit off-screen.
    const w = Math.min(f.w, Math.max(MIN_VISIBLE, stage.w))
    const h = Math.min(f.h, Math.max(MIN_VISIBLE, stage.h))
    panes.push({
      id: f.id,
      x: clamp(f.x, stage.x - w + MIN_VISIBLE, stage.x + Math.max(0, stage.w - MIN_VISIBLE)),
      y: clamp(f.y, stage.y, stage.y + Math.max(0, stage.h - HEADER_VISIBLE)),
      w,
      h,
      floating: true,
      hidden: false,
      z: 100 + f.z
    })
  }

  if (layout.zoomed) {
    for (const p of panes) {
      if (p.id === layout.zoomed) {
        p.x = stage.x
        p.y = stage.y
        p.w = stage.w
        p.h = stage.h
        p.z = 1000
        p.hidden = false
      } else {
        p.hidden = true
      }
    }
    return { panes, gutters: [] }
  }

  return { panes, gutters }
}

function walk(
  node: LayoutNode,
  rect: Rect,
  path: string,
  panes: PaneLayout[],
  gutters: GutterLayout[]
): void {
  if (node.kind === 'leaf') {
    panes.push({ id: node.id, ...rect, floating: false, hidden: false, z: 1 })
    return
  }

  if (node.dir === 'h') {
    const usable = Math.max(0, rect.w - GAP)
    const aw = Math.round(usable * node.ratio)
    const bw = usable - aw
    walk(node.a, { ...rect, w: aw }, `${path}a`, panes, gutters)
    walk(node.b, { ...rect, x: rect.x + aw + GAP, w: bw }, `${path}b`, panes, gutters)
    // The actual gutter extends from rect.x+aw to rect.x+aw+GAP: the hit
    // area is centered on it to prevent grabbing adjacent content.
    gutters.push({
      path,
      dir: 'h',
      x: rect.x + aw - GUTTER_HIT,
      y: rect.y,
      w: GAP + GUTTER_HIT * 2,
      h: rect.h
    })
  } else {
    const usable = Math.max(0, rect.h - GAP)
    const ah = Math.round(usable * node.ratio)
    const bh = usable - ah
    walk(node.a, { ...rect, h: ah }, `${path}a`, panes, gutters)
    walk(node.b, { ...rect, y: rect.y + ah + GAP, h: bh }, `${path}b`, panes, gutters)
    gutters.push({
      path,
      dir: 'v',
      x: rect.x,
      y: rect.y + ah - GUTTER_HIT,
      w: rect.w,
      h: GAP + GUTTER_HIT * 2
    })
  }
}

/**
 * Nearest pane in the specified direction, calculated by center points.
 * Perpendicular offset is weighted double the axial distance, so pressing
 * "right" moves to the pane directly to the right rather than one far above
 * that happens to start slightly further right.
 */
export function paneInDirection(
  panes: PaneLayout[],
  fromId: string,
  dir: Direction
): string | null {
  const from = panes.find((p) => p.id === fromId)
  if (!from) return null

  const fc = center(from)
  let best: { id: string; score: number } | null = null

  for (const p of panes) {
    if (p.id === fromId || p.hidden) continue
    const pc = center(p)
    const dx = pc.x - fc.x
    const dy = pc.y - fc.y

    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    if (along <= 1) continue

    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
    const score = along + across * 2

    if (!best || score < best.score) best = { id: p.id, score }
  }

  return best?.id ?? null
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/** Fraction of the pane, from center, that counts as "swap" rather than "split". */
const CENTER_ZONE = 0.22

/**
 * Drop zone corresponding to a point inside a pane.
 *
 * Compares normalized offsets from center across both dimensions rather
 * than raw pixels: on very wide/short panes, top/bottom edges would otherwise be unreachable.
 */
export function dropSideAt(rect: Rect, point: { x: number; y: number }): DropSide {
  const w = Math.max(1, rect.w)
  const h = Math.max(1, rect.h)
  const dx = (point.x - (rect.x + w / 2)) / w
  const dy = (point.y - (rect.y + h / 2)) / h

  if (Math.abs(dx) < CENTER_ZONE && Math.abs(dy) < CENTER_ZONE) return 'center'
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

/** Target area occupied by dropped pane, for preview rendering. */
export function dropPreviewRect(rect: Rect, side: DropSide): Rect {
  switch (side) {
    case 'left':
      return { ...rect, w: rect.w / 2 }
    case 'right':
      return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 }
    case 'top':
      return { ...rect, h: rect.h / 2 }
    case 'bottom':
      return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 }
    default:
      return rect
  }
}

/** Visible pane beneath point, excluding the dragged pane. */
export function paneAt(
  panes: PaneLayout[],
  point: { x: number; y: number },
  exclude: string
): PaneLayout | null {
  // Top-to-bottom: floating panes occlude tiled layout.
  const ordered = [...panes].sort((a, b) => b.z - a.z)
  return (
    ordered.find(
      (p) =>
        p.id !== exclude &&
        !p.hidden &&
        point.x >= p.x &&
        point.x <= p.x + p.w &&
        point.y >= p.y &&
        point.y <= p.y + p.h
    ) ?? null
  )
}

/** New split ratio given point where gutter was dragged. */
export function ratioFromPointer(
  splitRect: Rect,
  dir: SplitDir,
  pointer: { x: number; y: number }
): number {
  // The pointer grabs the CENTER of the gutter, which is GAP/2 past the edge
  // of the first child. Without subtracting it, the divider would jump by 4px on initial touch.
  if (dir === 'h') {
    const usable = Math.max(1, splitRect.w - GAP)
    return (pointer.x - splitRect.x - GAP / 2) / usable
  }
  const usable = Math.max(1, splitRect.h - GAP)
  return (pointer.y - splitRect.y - GAP / 2) / usable
}

/**
 * Geometry of split node identified by path. Used during gutter dragging:
 * ratio must be calculated relative to parent rectangle, not stage rectangle.
 */
export function rectOfSplit(layout: Layout, stage: Rect, path: string): Rect | null {
  let node = layout.root
  let rect = stage
  for (const step of path) {
    if (!node || node.kind !== 'split') return null
    if (node.dir === 'h') {
      const usable = Math.max(0, rect.w - GAP)
      const aw = Math.round(usable * node.ratio)
      rect = step === 'a' ? { ...rect, w: aw } : { ...rect, x: rect.x + aw + GAP, w: usable - aw }
    } else {
      const usable = Math.max(0, rect.h - GAP)
      const ah = Math.round(usable * node.ratio)
      rect = step === 'a' ? { ...rect, h: ah } : { ...rect, y: rect.y + ah + GAP, h: usable - ah }
    }
    node = step === 'a' ? node.a : node.b
  }
  return node && node.kind === 'split' ? rect : null
}
