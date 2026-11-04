import { useCallback, useEffect, useState } from 'react'
import type { MonitorState } from '@shared/types'
import { MonitorPanel } from './MonitorPanel'

/**
 * Side drawer anchored to right window edge.
 *
 * Toggling the drawer resizes the stage rather than covering panes.
 */

interface DrawerProps {
  open: boolean
  onToggle: () => void
  /** True when detached into its own window. */
  detached: boolean
  onDetach: () => void
  onAttach: () => void
  onFocusPane: (paneId: string) => void
}

export function Drawer({
  open,
  onToggle,
  detached,
  onDetach,
  onAttach,
  onFocusPane
}: DrawerProps): React.JSX.Element {
  const [state, setState] = useState<MonitorState | null>(null)

  useEffect(() => {
    if (!open || detached) return
    let alive = true
    void window.cm.monitor.subscribe().then((s) => alive && setState(s))
    const off = window.cm.monitor.onState(setState)
    return () => {
      alive = false
      off()
      window.cm.monitor.unsubscribe()
    }
  }, [open, detached])

  const toggle = useCallback(() => onToggle(), [onToggle])

  return (
    <>
      <button
        className={`cm-drawer__tab ${open ? 'cm-drawer__tab--open' : ''}`}
        onClick={toggle}
        title={open ? 'Close monitoring drawer' : 'Open monitoring drawer'}
        aria-expanded={open}
      >
        {open ? '›' : '‹'}
      </button>

      <aside className={`cm-drawer ${open ? 'cm-drawer--open' : ''}`} aria-hidden={!open}>
        <header className="cm-drawer__head">
          <span className="cm-drawer__title">Monitoring</span>
          <span className="cm-usage__spacer" />
          <button
            className="cm-iconbtn"
            title={
              detached
                ? 'Dock monitoring panel back to window'
                : 'Detach into always-on-top window'
            }
            onClick={detached ? onAttach : onDetach}
          >
            {detached ? '⇤' : '⇥'}
          </button>
        </header>

        {detached ? (
          <div className="cm-monitor__empty">
            Monitoring panel is running in a separate window.
            <br />
            <button className="cm-chip" onClick={onAttach}>
              Dock here
            </button>
          </div>
        ) : (
          <MonitorPanel state={state} onFocusPane={onFocusPane} />
        )}
      </aside>
    </>
  )
}
