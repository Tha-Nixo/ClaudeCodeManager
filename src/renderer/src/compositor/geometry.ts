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
  /** Nascosto perché un altro riquadro è ingrandito. Resta a dimensione piena
   *  per non innescare un resize del PTY che poi andrebbe annullato. */
  hidden: boolean
  z: number
}

export interface GutterLayout extends Rect {
  /** Percorso del nodo split da regolare durante il trascinamento. */
  path: string
  dir: SplitDir
}

/** Larghezza del canale fra due riquadri; l'area sensibile è più grande. */
export const GAP = 8
const GUTTER_HIT = 5
/** Striscia di riquadro flottante che deve restare sempre dentro lo stage. */
const MIN_VISIBLE = 80
const HEADER_VISIBLE = 30

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
    // Le coordinate salvate possono venire da uno schermo più grande: senza
    // riportarle dentro lo stage, dopo un ripristino il riquadro resterebbe
    // fuori campo e irraggiungibile. Gli stessi limiti usati nel trascinamento.
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
    // Il canale reale va da rect.x+aw a rect.x+aw+GAP: l'area sensibile va
    // centrata su quello, altrimenti si affera un divisore che sta altrove.
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
 * Riquadro più vicino nella direzione data, scelto sui centri.
 * Lo scostamento perpendicolare pesa il doppio della distanza lungo l'asse,
 * così premendo "destra" si finisce nel riquadro davvero a destra e non in
 * uno molto lontano verso l'alto che casualmente inizia poco più in là.
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

/** Frazione del riquadro, dal centro, che vale come "scambia" invece di "affianca". */
const CENTER_ZONE = 0.22

/**
 * Zona di rilascio corrispondente a un punto dentro un riquadro.
 *
 * Si confrontano gli scostamenti dal centro normalizzati sulle due dimensioni,
 * non in pixel: su un riquadro molto largo e basso, altrimenti, i bordi
 * superiore e inferiore sarebbero irraggiungibili.
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

/** Area che verrà occupata dal riquadro trascinato, per l'anteprima. */
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

/** Riquadro visibile sotto un punto, escluso quello trascinato. */
export function paneAt(
  panes: PaneLayout[],
  point: { x: number; y: number },
  exclude: string
): PaneLayout | null {
  // Dal più in alto verso il basso: i flottanti coprono il mosaico.
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

/** Nuovo rapporto di uno split dato il punto in cui è stato trascinato il canale. */
export function ratioFromPointer(
  splitRect: Rect,
  dir: SplitDir,
  pointer: { x: number; y: number }
): number {
  // Il puntatore afferra il CENTRO del canale, che sta a GAP/2 oltre il bordo
  // del primo figlio. Senza sottrarlo il divisore salterebbe di 4px appena lo
  // si tocca, prima ancora di muovere il mouse.
  if (dir === 'h') {
    const usable = Math.max(1, splitRect.w - GAP)
    return (pointer.x - splitRect.x - GAP / 2) / usable
  }
  const usable = Math.max(1, splitRect.h - GAP)
  return (pointer.y - splitRect.y - GAP / 2) / usable
}

/**
 * Geometria del nodo split identificato dal percorso. Serve durante il
 * trascinamento di un canale: il rapporto va calcolato rispetto al rettangolo
 * del genitore, non a quello dello stage.
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
