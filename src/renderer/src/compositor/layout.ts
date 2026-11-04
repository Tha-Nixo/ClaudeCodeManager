/**
 * Layout engine: binary split tree, similar to i3/sway.
 *
 * All functions are pure and return a new tree: state is directly serializable,
 * so this exact format is also persisted in layout.json for startup restoration.
 *
 * Direction conventions:
 *   'h' -> two children sit side-by-side (a left, b right)
 *   'v' -> two children are stacked      (a top,  b bottom)
 */

export type SplitDir = 'h' | 'v'
export type Direction = 'left' | 'right' | 'up' | 'down'

export type LayoutNode =
  | { kind: 'leaf'; id: string }
  | { kind: 'split'; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode }

export interface FloatingPane {
  id: string
  x: number
  y: number
  w: number
  h: number
  z: number
}

export interface Layout {
  root: LayoutNode | null
  floating: FloatingPane[]
  focused: string | null
  /** Pane temporarily zoomed to the full stage (Alt+Z). */
  zoomed: string | null
}

export const EMPTY_LAYOUT: Layout = { root: null, floating: [], focused: null, zoomed: null }

const MIN_RATIO = 0.1
const MAX_RATIO = 0.9

export function leaf(id: string): LayoutNode {
  return { kind: 'leaf', id }
}

/**
 * Path to a node as a string of 'a'/'b' steps from root ('' = root).
 * Stable for the duration of a drag gesture, which is all that is required.
 */
export function findPath(node: LayoutNode | null, id: string, prefix = ''): string | null {
  if (!node) return null
  if (node.kind === 'leaf') return node.id === id ? prefix : null
  return findPath(node.a, id, `${prefix}a`) ?? findPath(node.b, id, `${prefix}b`)
}

export function nodeAt(root: LayoutNode | null, path: string): LayoutNode | null {
  let current = root
  for (const step of path) {
    if (!current || current.kind !== 'split') return null
    // Any character other than 'a' was previously followed as 'b',
    // so garbage paths were not no-ops: they resized arbitrary splits.
    // Paths come from saved layout on disk, which is hand-editable.
    if (step !== 'a' && step !== 'b') return null
    current = step === 'a' ? current.a : current.b
  }
  return current
}

function replaceAt(root: LayoutNode, path: string, next: LayoutNode): LayoutNode {
  if (path.length === 0) return next
  if (root.kind !== 'split') return root
  const [step, ...rest] = path
  const child = step === 'a' ? root.a : root.b
  const replaced = replaceAt(child, rest.join(''), next)
  return step === 'a' ? { ...root, a: replaced } : { ...root, b: replaced }
}

export function collectLeaves(node: LayoutNode | null): string[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.id]
  return [...collectLeaves(node.a), ...collectLeaves(node.b)]
}

/** All panes, tiled and floating, in tree creation order. */
export function allPanes(layout: Layout): string[] {
  return [...collectLeaves(layout.root), ...layout.floating.map((f) => f.id)]
}

export function hasPane(layout: Layout, id: string): boolean {
  return allPanes(layout).includes(id)
}

// --- Operations -------------------------------------------------------------

/**
 * Inserts a pane by splitting the active one. If the layout is empty,
 * the new pane becomes the root.
 */
export function addPane(layout: Layout, id: string, dir: SplitDir): Layout {
  if (!layout.root) {
    return { ...layout, root: leaf(id), focused: id, zoomed: null }
  }

  // If the active pane is floating it cannot be split: append to the
  // tiled tree by splitting its first pane.
  const target =
    layout.focused && findPath(layout.root, layout.focused) !== null
      ? layout.focused
      : collectLeaves(layout.root)[0]

  const path = target ? findPath(layout.root, target) : null
  if (path === null || target === undefined) {
    return { ...layout, root: { kind: 'split', dir, ratio: 0.5, a: layout.root, b: leaf(id) }, focused: id }
  }

  const split: LayoutNode = { kind: 'split', dir, ratio: 0.5, a: leaf(target), b: leaf(id) }
  return { ...layout, root: replaceAt(layout.root, path, split), focused: id, zoomed: null }
}

/** Removes a pane and collapses the parent node onto the surviving sibling. */
export function removePane(layout: Layout, id: string): Layout {
  const floatIndex = layout.floating.findIndex((f) => f.id === id)
  if (floatIndex >= 0) {
    const floating = layout.floating.filter((f) => f.id !== id)
    return {
      ...layout,
      floating,
      focused: layout.focused === id ? fallbackFocus({ ...layout, floating }, id) : layout.focused,
      zoomed: layout.zoomed === id ? null : layout.zoomed
    }
  }

  const path = findPath(layout.root, id)
  if (path === null || !layout.root) return layout

  let root: LayoutNode | null
  if (path.length === 0) {
    root = null
  } else {
    const parentPath = path.slice(0, -1)
    const parent = nodeAt(layout.root, parentPath)
    if (!parent || parent.kind !== 'split') return layout
    const sibling = path.endsWith('a') ? parent.b : parent.a
    root = replaceAt(layout.root, parentPath, sibling)
  }

  const next: Layout = { ...layout, root, zoomed: layout.zoomed === id ? null : layout.zoomed }
  return { ...next, focused: layout.focused === id ? fallbackFocus(next, id) : layout.focused }
}

function fallbackFocus(layout: Layout, removed: string): string | null {
  return allPanes(layout).find((p) => p !== removed) ?? null
}

export function setFocus(layout: Layout, id: string): Layout {
  if (!hasPane(layout, id)) return layout
  // The floating pane receiving focus must also be brought to the front.
  const floating = layout.floating.some((f) => f.id === id)
    ? raiseFloating(layout.floating, id)
    : layout.floating
  return { ...layout, focused: id, floating }
}

function raiseFloating(floating: FloatingPane[], id: string): FloatingPane[] {
  const maxZ = floating.reduce((m, f) => Math.max(m, f.z), 0)
  return floating.map((f) => (f.id === id ? { ...f, z: maxZ + 1 } : f))
}

export function setRatio(layout: Layout, path: string, ratio: number): Layout {
  if (!layout.root) return layout
  const node = nodeAt(layout.root, path)
  if (!node || node.kind !== 'split') return layout
  // NaN passes through both Math.min and Math.max intact and gets stored:
  // geometry subsequently computes NaN widths and both split panes vanish
  // without errors. Infinity, on the other hand, is clamped correctly to bounds.
  // We explicitly reject NaN.
  if (Number.isNaN(ratio)) return layout
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
  return { ...layout, root: replaceAt(layout.root, path, { ...node, ratio: clamped }) }
}

/** Swaps positions of two tiled panes. */
export function swapPanes(layout: Layout, idA: string, idB: string): Layout {
  if (!layout.root || idA === idB) return layout
  const pathA = findPath(layout.root, idA)
  const pathB = findPath(layout.root, idB)
  if (pathA === null || pathB === null) return layout

  let root = replaceAt(layout.root, pathA, leaf(idB))
  root = replaceAt(root, pathB, leaf(idA))
  return { ...layout, root }
}

/**
 * Moves a pane between the tiled tree and the floating list.
 * `rect` is the pane's current geometry, ensuring conversion to floating
 * does not cause the window to jump to an unexpected location.
 */
export function toggleFloat(
  layout: Layout,
  id: string,
  rect: { x: number; y: number; w: number; h: number }
): Layout {
  const existing = layout.floating.find((f) => f.id === id)

  if (existing) {
    const floating = layout.floating.filter((f) => f.id !== id)
    const reattached = addPane({ ...layout, floating, focused: null }, id, defaultSplitDir(rect))
    return { ...reattached, focused: id }
  }

  if (findPath(layout.root, id) === null) return layout

  const detached = removePane({ ...layout, focused: null }, id)
  const maxZ = layout.floating.reduce((m, f) => Math.max(m, f.z), 0)
  return {
    ...detached,
    floating: [...detached.floating, { id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, z: maxZ + 1 }],
    focused: id,
    zoomed: null
  }
}

/** Wide panes split horizontally, tall panes split vertically. */
function defaultSplitDir(rect: { w: number; h: number }): SplitDir {
  return rect.w >= rect.h ? 'h' : 'v'
}

/** Drop target side relative to pane beneath pointer. */
export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * Moves a pane next to another via drag and drop.
 *
 * 'center' swaps the two; edges insert the dragged pane by splitting
 * the target pane. The pane is detached first to prevent duplicate entries.
 */
export function movePaneTo(
  layout: Layout,
  movingId: string,
  targetId: string,
  side: DropSide
): Layout {
  if (movingId === targetId) return layout
  if (!hasPane(layout, movingId) || !hasPane(layout, targetId)) return layout

  if (side === 'center') {
    // Swapping only makes sense between tiled panes: floating panes
    // do not occupy a fixed slot in the tree to swap with.
    if (isFloating(layout, movingId) || isFloating(layout, targetId)) return layout
    return setFocus(swapPanes(layout, movingId, targetId), movingId)
  }

  const detached = removePane({ ...layout, focused: null, zoomed: null }, movingId)
  if (!detached.root) return layout

  const path = findPath(detached.root, targetId)
  if (path === null) return layout

  const dir: SplitDir = side === 'left' || side === 'right' ? 'h' : 'v'
  const movingFirst = side === 'left' || side === 'top'
  const split: LayoutNode = {
    kind: 'split',
    dir,
    ratio: 0.5,
    a: movingFirst ? leaf(movingId) : leaf(targetId),
    b: movingFirst ? leaf(targetId) : leaf(movingId)
  }

  return {
    ...detached,
    root: replaceAt(detached.root, path, split),
    focused: movingId,
    zoomed: null
  }
}

export function toggleZoom(layout: Layout, id: string): Layout {
  if (!hasPane(layout, id)) return layout
  return { ...layout, zoomed: layout.zoomed === id ? null : id }
}

export function isFloating(layout: Layout, id: string): boolean {
  return layout.floating.some((f) => f.id === id)
}

export function updateFloating(
  layout: Layout,
  id: string,
  patch: Partial<Omit<FloatingPane, 'id'>>
): Layout {
  return {
    ...layout,
    floating: layout.floating.map((f) => (f.id === id ? { ...f, ...patch } : f))
  }
}
