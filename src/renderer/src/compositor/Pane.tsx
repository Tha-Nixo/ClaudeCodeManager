import { useCallback, useRef } from 'react'
import type { PaneLayout } from './geometry'
import type { SessionMeta } from '../state/types'
import { STATUS_LABEL } from '../state/types'
import { shortenPath } from '../util/path'
import { SearchBar } from '../terminal/SearchBar'

interface PaneProps {
  meta: SessionMeta
  rect: PaneLayout
  focused: boolean
  /** Questo riquadro è quello che si sta trascinando. */
  dragging: boolean
  /** Barra di ricerca aperta su questo riquadro. */
  searching: boolean
  onCloseSearch: () => void
  index: number
  onFocus: () => void
  onClose: () => void
  onSlotReady: (slot: HTMLDivElement) => void
  /** Trascinamento dall'intestazione: sposta i flottanti, riordina i tiled. */
  onHeaderDragStart: (e: React.PointerEvent) => void
  onFloatResizeStart: (e: React.PointerEvent) => void
}

export function Pane({
  meta,
  rect,
  focused,
  dragging,
  searching,
  onCloseSearch,
  index,
  onFocus,
  onClose,
  onSlotReady,
  onHeaderDragStart,
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

  const remote = meta.launch.remote
  const dotClass = `cm-pane__dot cm-pane__dot--${meta.status}`

  // Il registro delle sessioni vive sta sul computer locale; una sessione
  // remota scrive il proprio sul server, quindi qui non arriva mai. Dire
  // "pronta" sarebbe un'affermazione che non possiamo verificare: mentre la
  // connessione è viva si mostra "remota", e restano veri gli stati che
  // dipendono dal processo ssh locale (avvio, uscita, errore).
  const statusText =
    remote && meta.status === 'running' ? 'remota' : STATUS_LABEL[meta.status]

  const where = remote ? `${remote.user}@${remote.host}:${remote.path}` : meta.cwd

  return (
    <section
      // Identifica il riquadro nel DOM: serve ai test end-to-end per seguire
      // un riquadro mentre si sposta, cosa che la posizione non permette
      // perché due disposizioni diverse possono avere la stessa geometria.
      data-pane-id={meta.paneId}
      className={[
        'cm-pane',
        focused ? 'cm-pane--focused' : '',
        rect.floating ? 'cm-pane--floating' : '',
        rect.hidden ? 'cm-pane--hidden' : '',
        dragging ? 'cm-pane--dragging' : ''
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
        onPointerDown={onHeaderDragStart}
        onDoubleClick={onClose}
        title="Trascina per spostare il riquadro · doppio clic per chiuderlo"
      >
        <span className="cm-pane__index">{index}</span>
        <span className={dotClass} title={statusText} />
        {remote && (
          <span
            className="cm-pane__remote"
            title={`Sessione su ${remote.user}@${remote.host}${remote.port && remote.port !== 22 ? `:${remote.port}` : ''}`}
          >
            ☁ {remote.name}
          </span>
        )}
        <span className="cm-pane__path" title={where}>
          {meta.title ?? shortenPath(remote ? remote.path : meta.cwd, 52)}
        </span>
        <span className="cm-pane__meta">
          {rect.floating ? 'flottante · ' : ''}
          {statusText}
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

      {searching && <SearchBar paneId={meta.paneId} onClose={onCloseSearch} />}

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
