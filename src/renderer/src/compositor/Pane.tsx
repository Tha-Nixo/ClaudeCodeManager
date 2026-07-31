import { useCallback, useRef } from 'react'
import type { PaneLayout } from './geometry'
import type { SessionMeta } from '../state/types'
import { STATUS_LABEL } from '../state/types'
import { shortenPath } from '../util/path'

interface PaneProps {
  meta: SessionMeta
  rect: PaneLayout
  focused: boolean
  index: number
  onFocus: () => void
  onClose: () => void
  onSlotReady: (slot: HTMLDivElement) => void
  onFloatDragStart: (e: React.PointerEvent) => void
  onFloatResizeStart: (e: React.PointerEvent) => void
}

export function Pane({
  meta,
  rect,
  focused,
  index,
  onFocus,
  onClose,
  onSlotReady,
  onFloatDragStart,
  onFloatResizeStart
}: PaneProps): React.JSX.Element {
  const notified = useRef(false)

  // Callback ref invece di useEffect: lo slot va segnalato nell'istante in cui
  // entra nel DOM, perché è lì che il terminale può essere misurato.
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && !notified.current) {
        notified.current = true
        onSlotReady(el)
      }
    },
    [onSlotReady]
  )

  const dotClass = `cm-pane__dot cm-pane__dot--${meta.status}`

  return (
    <section
      className={[
        'cm-pane',
        focused ? 'cm-pane--focused' : '',
        rect.floating ? 'cm-pane--floating' : '',
        rect.hidden ? 'cm-pane--hidden' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: rect.z,
        visibility: rect.hidden ? 'hidden' : 'visible'
      }}
      onPointerDown={onFocus}
    >
      <header
        className="cm-pane__header"
        onPointerDown={rect.floating ? onFloatDragStart : undefined}
        onDoubleClick={onClose}
      >
        <span className="cm-pane__index">{index}</span>
        <span className={dotClass} title={STATUS_LABEL[meta.status]} />
        <span className="cm-pane__path" title={meta.cwd}>
          {meta.title ?? shortenPath(meta.cwd, 52)}
        </span>
        <span className="cm-pane__meta">
          {rect.floating ? 'flottante · ' : ''}
          {STATUS_LABEL[meta.status]}
        </span>
        <button
          className="cm-pane__close"
          title="Chiudi riquadro (Alt+W)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="cm-pane__body" ref={slotRef}>
        {meta.status === 'error' && (
          <div className="cm-notice">
            <div className="cm-notice__title">Impossibile avviare il terminale</div>
            <div>{meta.error}</div>
          </div>
        )}
      </div>

      {rect.floating && (
        <div
          className="cm-pane__resize"
          title="Ridimensiona"
          onPointerDown={onFloatResizeStart}
        />
      )}
    </section>
  )
}
