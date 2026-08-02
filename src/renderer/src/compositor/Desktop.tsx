import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DropSide, Layout } from './layout'
import {
  computeLayout,
  dropPreviewRect,
  dropSideAt,
  paneAt,
  ratioFromPointer,
  rectOfSplit,
  type GutterLayout,
  type Rect
} from './geometry'
import { Pane } from './Pane'
import type { SessionMeta } from '../state/types'
import { setFitSuspendedAll } from '../terminal/registry'

interface DesktopProps {
  layout: Layout
  sessions: Record<string, SessionMeta>
  onFocusPane: (paneId: string) => void
  onClosePane: (paneId: string) => void
  onSlotReady: (paneId: string, slot: HTMLDivElement) => void
  onSetRatio: (path: string, ratio: number) => void
  onMoveFloating: (paneId: string, x: number, y: number) => void
  onResizeFloating: (paneId: string, w: number, h: number) => void
  onDropPane: (movingId: string, targetId: string, side: DropSide) => void
  onRectsChange: (rects: Record<string, Rect>) => void
  /** Riquadro con la barra di ricerca aperta, se ce n'è uno. */
  searchPaneId: string | null
  onCloseSearch: () => void
}

const MIN_FLOAT = 220
/** Spostamento oltre il quale un clic sull'intestazione diventa trascinamento. */
const DRAG_THRESHOLD = 5
/** Deve restare allineata alla durata della transizione in claude-dark.css. */
const ANIMATION_MS = 190

interface DragState {
  paneId: string
  target: { id: string; side: DropSide } | null
  pointer: { x: number; y: number }
}

export function Desktop({
  layout,
  sessions,
  onFocusPane,
  onClosePane,
  onSlotReady,
  onSetRatio,
  onMoveFloating,
  onResizeFloating,
  onDropPane,
  onRectsChange,
  searchPaneId,
  onCloseSearch
}: DesktopProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<DragState | null>(null)
  /**
   * Copia sincrona dello stato di trascinamento. Serve perché al rilascio la
   * decisione va presa subito: leggerla da dentro un updater di setState
   * significherebbe eseguire un effetto collaterale in fase di render, che
   * React è libero di scartare — ed è esattamente quello che faceva.
   */
  const dragRef = useRef<DragState | null>(null)
  const updateDrag = useCallback((next: DragState | null) => {
    dragRef.current = next
    setDrag(next)
  }, [])
  const [animating, setAnimating] = useState(false)

  /**
   * Le transizioni valgono solo per i cambi di LAYOUT, non per quelli dello
   * stage: ridimensionando la finestra i riquadri devono seguire il bordo
   * senza inseguirlo con un ritardo. E vanno spente durante un trascinamento,
   * dove il riquadro deve stare sotto il puntatore.
   */
  const interacting = useRef(false)
  const previousLayout = useRef(layout)
  const animationTimer = useRef(0)

  useEffect(() => {
    const changed = previousLayout.current !== layout
    previousLayout.current = layout
    if (!changed || interacting.current) return

    setAnimating(true)
    setFitSuspendedAll(true)
    if (animationTimer.current) clearTimeout(animationTimer.current)
    animationTimer.current = window.setTimeout(() => {
      animationTimer.current = 0
      setAnimating(false)
      // Una sola rimisurazione a transizione conclusa, invece di una per frame.
      setFitSuspendedAll(false)
    }, ANIMATION_MS)
  }, [layout])

  useEffect(
    () => () => {
      if (animationTimer.current) clearTimeout(animationTimer.current)
      setFitSuspendedAll(false)
    },
    []
  )

  // Il layout dipende dalla dimensione dello stage, che va misurata dopo il
  // primo paint e poi ad ogni cambio di finestra.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setStageSize({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const stage: Rect = { x: 0, y: 0, w: stageSize.w, h: stageSize.h }
  const { panes, gutters } = computeLayout(layout, stage)

  // I gestori di trascinamento vivono per tutta la durata del gesto e
  // catturerebbero i riquadri di quando è iniziato: qui leggono sempre gli
  // ultimi calcolati.
  const panesRef = useRef(panes)
  panesRef.current = panes

  // Pubblica le geometrie: servono al focus direzionale e al passaggio
  // tiled -> flottante, che deve partire dalla posizione attuale.
  useEffect(() => {
    const rects: Record<string, Rect> = {}
    for (const p of panes) rects[p.id] = { x: p.x, y: p.y, w: p.w, h: p.h }
    onRectsChange(rects)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(panes.map((p) => [p.id, p.x, p.y, p.w, p.h]))])

  const stageOrigin = useCallback((): { left: number; top: number } => {
    const r = stageRef.current?.getBoundingClientRect()
    return { left: r?.left ?? 0, top: r?.top ?? 0 }
  }, [])

  /** Trascinamento di un riquadro del mosaico per riordinarlo. */
  const onTileDragStart = useCallback(
    (e: React.PointerEvent, paneId: string) => {
      // Solo il tasto principale, e non sui comandi dell'intestazione.
      if (e.button !== 0) return
      const origin = stageOrigin()
      const startX = e.clientX
      const startY = e.clientY
      let started = false

      const move = (ev: PointerEvent): void => {
        if (!started) {
          // Sotto soglia resta un clic: altrimenti selezionare un riquadro
          // farebbe partire un trascinamento a ogni tremolio del mouse.
          if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return
          started = true
          interacting.current = true
          document.body.classList.add('cm-dragging')
        }

        const point = { x: ev.clientX - origin.left, y: ev.clientY - origin.top }
        const over = paneAt(panesRef.current, point, paneId)
        updateDrag({
          paneId,
          pointer: point,
          target: over ? { id: over.id, side: dropSideAt(over, point) } : null
        })
      }

      const finish = (apply: boolean): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('keydown', onKey, { capture: true })
        document.body.classList.remove('cm-dragging')
        interacting.current = false

        const current = dragRef.current
        updateDrag(null)
        if (apply && current?.target) {
          onDropPane(current.paneId, current.target.id, current.target.side)
        }
      }

      const up = (): void => finish(true)
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('keydown', onKey, { capture: true })
    },
    [stageOrigin, onDropPane, updateDrag]
  )

  /** Trascinamento di un canale fra due riquadri affiancati. */
  const onGutterDown = useCallback(
    (e: React.PointerEvent, gutter: GutterLayout) => {
      e.preventDefault()
      const splitRect = rectOfSplit(layout, stage, gutter.path)
      if (!splitRect) return
      const origin = stageOrigin()

      const move = (ev: PointerEvent): void => {
        onSetRatio(
          gutter.path,
          ratioFromPointer(splitRect, gutter.dir, {
            x: ev.clientX - origin.left,
            y: ev.clientY - origin.top
          })
        )
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.classList.remove('cm-dragging')
        interacting.current = false
      }
      interacting.current = true
      document.body.classList.add('cm-dragging')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [layout, stage, onSetRatio, stageOrigin]
  )

  /** Spostamento di un riquadro flottante afferrandone l'intestazione. */
  const onFloatDragStart = useCallback(
    (e: React.PointerEvent, paneId: string) => {
      // L'origine va letta da layout.floating, non dai rettangoli calcolati:
      // sotto zoom quelli sono stati sovrascritti con le misure dello stage, e
      // partire da lì distruggerebbe la geometria memorizzata del riquadro.
      const pane = layout.floating.find((f) => f.id === paneId)
      if (!pane) return
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      const originX = pane.x
      const originY = pane.y

      const move = (ev: PointerEvent): void => {
        // Si tiene sempre una striscia del riquadro dentro lo stage,
        // altrimenti diventa irraggiungibile.
        const x = clamp(originX + (ev.clientX - startX), -pane.w + 80, stage.w - 80)
        const y = clamp(originY + (ev.clientY - startY), 0, stage.h - 30)
        onMoveFloating(paneId, x, y)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.classList.remove('cm-dragging')
        interacting.current = false
      }
      interacting.current = true
      document.body.classList.add('cm-dragging')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [layout.floating, stage, onMoveFloating]
  )

  const onFloatResizeStart = useCallback(
    (e: React.PointerEvent, paneId: string) => {
      const pane = layout.floating.find((f) => f.id === paneId)
      if (!pane) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const originW = pane.w
      const originH = pane.h

      const move = (ev: PointerEvent): void => {
        onResizeFloating(
          paneId,
          Math.max(MIN_FLOAT, originW + (ev.clientX - startX)),
          Math.max(140, originH + (ev.clientY - startY))
        )
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.classList.remove('cm-dragging')
        interacting.current = false
      }
      interacting.current = true
      document.body.classList.add('cm-dragging')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [layout.floating, onResizeFloating]
  )

  const dropTarget = drag?.target
    ? panes.find((p) => p.id === drag.target?.id)
    : null
  const dropRect = dropTarget && drag?.target ? dropPreviewRect(dropTarget, drag.target.side) : null

  const ordered = [...panes].sort((a, b) => a.z - b.z)
  // Numerazione su TUTTI i riquadri, nell'ordine dell'albero: è la stessa che
  // usa Alt+1..9. Escludere quelli nascosti dallo zoom li rinumererebbe, e il
  // numero mostrato non corrisponderebbe più al tasto da premere.
  const indexOf = new Map(panes.map((p, i) => [p.id, i + 1]))

  return (
    <main
      className={`cm-stage${animating ? ' cm-stage--animate' : ''}${drag ? ' cm-stage--dragging' : ''}`}
      ref={stageRef}
    >
      {stageSize.w > 0 &&
        ordered.map((rect) => {
          const meta = sessions[rect.id]
          if (!meta) return null
          return (
            <Pane
              key={rect.id}
              meta={meta}
              rect={rect}
              index={indexOf.get(rect.id) ?? 0}
              focused={layout.focused === rect.id}
              dragging={drag?.paneId === rect.id}
              searching={searchPaneId === rect.id}
              onCloseSearch={onCloseSearch}
              onFocus={() => onFocusPane(rect.id)}
              onClose={() => onClosePane(rect.id)}
              onSlotReady={(slot) => onSlotReady(rect.id, slot)}
              onHeaderDragStart={(e) =>
                rect.floating ? onFloatDragStart(e, rect.id) : onTileDragStart(e, rect.id)
              }
              onFloatResizeStart={(e) => onFloatResizeStart(e, rect.id)}
            />
          )
        })}

      {dropRect && drag?.target && (
        <div
          className={`cm-drop cm-drop--${drag.target.side}`}
          style={{ left: dropRect.x, top: dropRect.y, width: dropRect.w, height: dropRect.h }}
        >
          <span className="cm-drop__label">
            {drag.target.side === 'center' ? 'scambia' : 'affianca'}
          </span>
        </div>
      )}

      {gutters.map((g) => (
        <div
          key={g.path || 'root'}
          className={`cm-gutter cm-gutter--${g.dir}`}
          style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
          onPointerDown={(e) => onGutterDown(e, g)}
        />
      ))}

      {panes.length === 0 && (
        <div className="cm-notice">
          <div className="cm-notice__title">Nessuna sessione aperta</div>
          <div>
            <span className="cm-kbd">Alt+N</span> per aprirne una
          </div>
        </div>
      )}
    </main>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
