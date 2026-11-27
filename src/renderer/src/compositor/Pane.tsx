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
  /** This pane is the one being dragged. */
  dragging: boolean
  /** The search bar is open on this pane. */
  searching: boolean
  onCloseSearch: () => void
  index: number
  onFocus: () => void
  onClose: () => void
  /** Closes this pane and opens the folder picker: offered when launch failed. */
  onReplace: () => void
  onSlotReady: (slot: HTMLDivElement) => void
  /** Drag from the header: moves floating panes, reorders tiled ones. */
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
  onReplace,
  onSlotReady,
  onHeaderDragStart,
  onFloatResizeStart
}: PaneProps): React.JSX.Element {
  const notified = useRef(false)

  // A callback ref instead of useEffect: the slot must be reported the instant
  // it enters the DOM, because that is when the terminal can be measured.
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

  // The registry of live sessions is on the local computer; a remote session
  // writes its own on the server, so it never arrives here. Saying "ready"
  // would be a claim we cannot check: while the connection is alive the pane
  // shows "remote", and the states that depend on the local ssh process
  // (starting, exited, error) stay true.
  const statusText =
    remote && meta.status === 'running' ? 'remote' : STATUS_LABEL[meta.status]

  const where = remote ? `${remote.user}@${remote.host}:${remote.path}` : meta.cwd

  return (
    <section
      // Identifies the pane in the DOM: end-to-end tests use it to follow a pane
      // while it moves, which its position cannot do, because two different
      // arrangements can have the same geometry.
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
        title="Drag to move pane · double-click to close"
      >
        <span className="cm-pane__index">{index}</span>
        <span className={dotClass} title={statusText} />
        {remote && (
          <span
            className="cm-pane__remote"
            title={`Session on ${remote.user}@${remote.host}${remote.port && remote.port !== 22 ? `:${remote.port}` : ''}`}
          >
            ☁ {remote.name}
          </span>
        )}
        <span className="cm-pane__path" title={where}>
          {meta.title ?? shortenPath(remote ? remote.path : meta.cwd, 52)}
        </span>
        <span className="cm-pane__meta">
          {rect.floating ? 'floating · ' : ''}
          {statusText}
        </span>
        <button
          className="cm-pane__close"
          title="Close pane (Alt+W)"
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
            <div className="cm-notice__title">Unable to launch terminal</div>
            <div>{meta.error}</div>
            <button
              className="cm-chip"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onReplace}
            >
              Choose a folder…
            </button>
          </div>
        )}
      </div>

      {rect.floating && (
        <div
          className="cm-pane__resize"
          title="Resize"
          onPointerDown={onFloatResizeStart}
        />
      )}
    </section>
  )
}
