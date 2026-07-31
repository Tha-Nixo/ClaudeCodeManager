/**
 * Motore di layout: albero binario di split, come i3/sway.
 *
 * Tutte le funzioni sono pure e restituiscono un nuovo albero: lo stato è
 * direttamente serializzabile, quindi questo stesso formato è anche quello
 * salvato in layout.json per il ripristino all'avvio.
 *
 * Convenzione delle direzioni:
 *   'h' -> i due figli stanno affiancati   (a sinistra, b destra)
 *   'v' -> i due figli stanno impilati     (a sopra,    b sotto)
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
  /** Riquadro momentaneamente ingrandito a tutto lo stage (Alt+Z). */
  zoomed: string | null
}

export const EMPTY_LAYOUT: Layout = { root: null, floating: [], focused: null, zoomed: null }

const MIN_RATIO = 0.1
const MAX_RATIO = 0.9

export function leaf(id: string): LayoutNode {
  return { kind: 'leaf', id }
}

/**
 * Percorso di un nodo come stringa di 'a'/'b' dalla radice ('' = radice).
 * Stabile per la durata di un trascinamento, che è tutto ciò che serve.
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

/** Tutti i riquadri, affiancati e flottanti, nell'ordine di creazione dell'albero. */
export function allPanes(layout: Layout): string[] {
  return [...collectLeaves(layout.root), ...layout.floating.map((f) => f.id)]
}

export function hasPane(layout: Layout, id: string): boolean {
  return allPanes(layout).includes(id)
}

// --- Operazioni -------------------------------------------------------------

/**
 * Inserisce un riquadro dividendo quello attivo. Se il layout è vuoto il
 * nuovo riquadro diventa la radice.
 */
export function addPane(layout: Layout, id: string, dir: SplitDir): Layout {
  if (!layout.root) {
    return { ...layout, root: leaf(id), focused: id, zoomed: null }
  }

  // Se il riquadro attivo è flottante non si può dividere: si aggiunge in coda
  // all'albero affiancato dividendo il suo primo riquadro.
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

/** Rimuove un riquadro e fa collassare il genitore sul fratello superstite. */
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
  // Il riquadro flottante che riceve il fuoco va anche portato in primo piano.
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
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
  return { ...layout, root: replaceAt(layout.root, path, { ...node, ratio: clamped }) }
}

/** Scambia di posto due riquadri affiancati. */
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
 * Sposta un riquadro fra albero affiancato e lista flottante.
 * `rect` è la geometria attuale del riquadro, così il passaggio a flottante
 * non fa saltare la finestra da un'altra parte.
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

/** Un riquadro largo si divide in verticale, uno alto in orizzontale. */
function defaultSplitDir(rect: { w: number; h: number }): SplitDir {
  return rect.w >= rect.h ? 'h' : 'v'
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
