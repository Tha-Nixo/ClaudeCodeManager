import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Layout } from './layout'
import { computeLayout, ratioFromPointer, rectOfSplit, type GutterLayout, type Rect } from './geometry'
import { Pane } from './Pane'
import type { SessionMeta } from '../state/types'

interface DesktopProps {
  layout: Layout
  sessions: Record<string, SessionMeta>
  onFocusPane: (paneId: string) => void
  onClosePane: (paneId: string) => void
  onSlotReady: (paneId: string, slot: HTMLDivElement) => void
  onSetRatio: (path: string, ratio: number) => void
  onMoveFloating: (paneId: string, x: number, y: number) => void
  onResizeFloating: (paneId: string, w: number, h: number) => void
  onRectsChange: (rects: Record<string, Rect>) => void
}

const MIN_FLOAT = 220

export function Desktop({
  layout,
  sessions,
  onFocusPane,
  onClosePane,
  onSlotReady,
  onSetRatio,
  onMoveFloating,
  onResizeFloating,
  onRectsChange
}: DesktopProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })

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
      }
      document.body.classList.add('cm-dragging')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [layout, stage, onSetRatio, stageOrigin]
  )

  /** Spostamento di un riquadro flottante afferrandone l'intestazione. */
  const onFloatDragStart = useCallback(
    (e: React.PointerEvent, paneId: string) => {
      const pane = panes.find((p) => p.id === paneId)
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
      }
      document.body.classList.add('cm-dragging')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [panes, stage, onMoveFloating]
  )

  const onFloatResizeStart = useCallback(
    (e: React.PointerEvent, paneId: string) => {
      const pane = panes.find((p) => p.id === paneId)
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
      }
      document.body.classList.add('cm-dragging')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [panes, onResizeFloating]
  )

  const ordered = [...panes].sort((a, b) => a.z - b.z)
  // Numerazione su TUTTI i riquadri, nell'ordine dell'albero: è la stessa che
  // usa Alt+1..9. Escludere quelli nascosti dallo zoom li rinumererebbe, e il
  // numero mostrato non corrisponderebbe più al tasto da premere.
  const indexOf = new Map(panes.map((p, i) => [p.id, i + 1]))

  return (
    <main className="cm-stage" ref={stageRef}>
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
              onFocus={() => onFocusPane(rect.id)}
              onClose={() => onClosePane(rect.id)}
              onSlotReady={(slot) => onSlotReady(rect.id, slot)}
              onFloatDragStart={(e) => onFloatDragStart(e, rect.id)}
              onFloatResizeStart={(e) => onFloatResizeStart(e, rect.id)}
            />
          )
        })}

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
