import { useEffect, useRef, useState } from 'react'
import { createSession, wireTerminalEvents } from './terminal/registry'
import { shortenPath } from './util/path'

type PaneStatus = 'starting' | 'running' | 'exited' | 'error'

export default function App(): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)

  const [cwd, setCwd] = useState('')
  const [status, setStatus] = useState<PaneStatus>('starting')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [dims, setDims] = useState<{ cols: number; rows: number } | null>(null)

  // Instrada gli eventi del PTY verso i terminali. Una volta sola.
  useEffect(() => wireTerminalEvents(), [])

  // Segnala la morte della shell nel pallino di stato.
  useEffect(() => window.cm.pty.onExit(() => setStatus('exited')), [])

  // Scorciatoie sempre disponibili. Sono anche l'unica via d'uscita da una
  // finestra senza bordi a schermo intero: vanno registrate prima di tutto.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'F11') {
        e.preventDefault()
        window.cm.win.toggleFullscreen()
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        window.cm.win.quit()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  // Avvio della prima sessione.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    void (async () => {
      const slot = slotRef.current
      if (!slot) return
      try {
        const config = await window.cm.config.get()
        setCwd(config.defaultCwd)
        const { host } = await createSession(slot, {
          cwd: config.defaultCwd,
          model: config.launchDefaults.model,
          effort: config.launchDefaults.effort,
          permissionMode: config.launchDefaults.permissionMode
        })
        host.onResize = setDims
        setDims(host.dimensions)
        setStatus('running')
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    })()
  }, [])

  return (
    <div className="cm-desktop">
      <header className="cm-topbar">
        <span className="cm-topbar__brand">ClaudeManager</span>
        <span className="cm-topbar__hint">
          <span className="cm-kbd">F11</span> schermo intero ·{' '}
          <span className="cm-kbd">Ctrl+Shift+Q</span> esci
        </span>
        <div className="cm-topbar__spacer" />
        <div className="cm-topbar__buttons">
          <button
            className="cm-iconbtn"
            title="Riduci a icona"
            onClick={() => window.cm.win.minimize()}
          >
            ─
          </button>
          <button
            className="cm-iconbtn"
            title="Schermo intero (F11)"
            onClick={() => window.cm.win.toggleFullscreen()}
          >
            ▢
          </button>
          <button
            className="cm-iconbtn cm-iconbtn--danger"
            title="Esci (Ctrl+Shift+Q)"
            onClick={() => window.cm.win.quit()}
          >
            ✕
          </button>
        </div>
      </header>

      <main className="cm-stage">
        <section className="cm-pane cm-pane--focused" style={{ inset: 0 }}>
          <div className="cm-pane__header">
            <span className={`cm-pane__dot cm-pane__dot--${statusClass(status)}`} />
            <span className="cm-pane__path" title={cwd}>
              {cwd ? shortenPath(cwd, 70) : 'avvio…'}
            </span>
            <span className="cm-pane__meta">
              {dims ? `${dims.cols}×${dims.rows}` : ''}
              {status === 'exited' ? ' · shell terminata' : ''}
            </span>
          </div>

          <div className="cm-pane__body" ref={slotRef}>
            {status === 'error' && (
              <div className="cm-notice">
                <div className="cm-notice__title">Impossibile avviare il terminale</div>
                <div>{errorMsg}</div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

function statusClass(status: PaneStatus): string {
  switch (status) {
    case 'running':
      return 'running'
    case 'exited':
      return 'exited'
    case 'error':
      return 'exited'
    default:
      return 'idle'
  }
}
