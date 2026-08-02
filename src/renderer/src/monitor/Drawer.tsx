import { useCallback, useEffect, useState } from 'react'
import type { MonitorState } from '@shared/types'
import { MonitorPanel } from './MonitorPanel'

/**
 * Cassetto agganciato al bordo destro.
 *
 * La linguetta resta sempre visibile e ne comanda l'apertura. Il cassetto non
 * copre i riquadri: restringe il palco, così niente resta nascosto dietro.
 * È il motivo per cui il `ResizeObserver` del compositor basta da solo a
 * rifare le geometrie — non serve toccare il motore di layout.
 */

interface DrawerProps {
  open: boolean
  onToggle: () => void
  /** Il pannello è staccato in una finestra propria: il cassetto resta vuoto. */
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

  // Ci si iscrive solo quando il cassetto è aperto: a cassetto chiuso il main
  // non deve rileggere i transcript ogni due secondi per nessuno.
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
        title={open ? 'Chiudi il pannello' : 'Apri il pannello di monitoraggio'}
        aria-expanded={open}
      >
        {open ? '›' : '‹'}
      </button>

      <aside className={`cm-drawer ${open ? 'cm-drawer--open' : ''}`} aria-hidden={!open}>
        <header className="cm-drawer__head">
          <span className="cm-drawer__title">Monitoraggio</span>
          <span className="cm-usage__spacer" />
          <button
            className="cm-iconbtn"
            title={
              detached
                ? 'Riporta il pannello dentro la finestra'
                : 'Stacca in una finestra sempre in primo piano'
            }
            onClick={detached ? onAttach : onDetach}
          >
            {detached ? '⇤' : '⇥'}
          </button>
        </header>

        {detached ? (
          <div className="cm-monitor__empty">
            Il pannello è in una finestra separata.
            <br />
            <button className="cm-chip" onClick={onAttach}>
              Riportalo qui
            </button>
          </div>
        ) : (
          <MonitorPanel state={state} onFocusPane={onFocusPane} />
        )}
      </aside>
    </>
  )
}
