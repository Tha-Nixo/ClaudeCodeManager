import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig, LaunchOptions, LiveSession } from '@shared/types'
import { Desktop } from './compositor/Desktop'
import type { Rect } from './compositor/geometry'
import { paneInDirection } from './compositor/geometry'
import {
  EMPTY_LAYOUT,
  addPane,
  allPanes,
  collectLeaves,
  isFloating,
  removePane,
  setFocus,
  setRatio,
  swapPanes,
  toggleFloat,
  toggleZoom,
  updateFloating,
  type Direction,
  type Layout,
  type SplitDir
} from './compositor/layout'
import { installKeyHandler, type Action } from './keys/bindings'
import { Selector } from './selector/Selector'
import { paneStatusFromLive, type SessionMeta } from './state/types'
import { basename } from './util/path'
import {
  destroySession,
  ensureSession,
  focusPane,
  isStarted,
  setSessionEvents,
  wireTerminalEvents
} from './terminal/registry'

export default function App(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [layout, setLayout] = useState<Layout>(EMPTY_LAYOUT)
  const [sessions, setSessions] = useState<Record<string, SessionMeta>>({})
  const [selectorOpen, setSelectorOpen] = useState(false)
  const selectorOpenRef = useRef(false)
  selectorOpenRef.current = selectorOpen

  // Geometrie correnti dei riquadri. Sono un ref e non uno stato: servono solo
  // dentro i gestori (focus direzionale, passaggio a flottante) e non devono
  // provocare render.
  const rectsRef = useRef<Record<string, Rect>>({})
  const layoutRef = useRef(layout)
  const sessionsRef = useRef(sessions)
  layoutRef.current = layout
  sessionsRef.current = sessions

  const bootstrapped = useRef(false)

  const patchSession = useCallback((paneId: string, patch: Partial<SessionMeta>) => {
    setSessions((prev) => (prev[paneId] ? { ...prev, [paneId]: { ...prev[paneId], ...patch } } : prev))
  }, [])

  // --- Creazione e chiusura sessioni ----------------------------------------

  const newSession = useCallback((opts: LaunchOptions, dir: SplitDir) => {
    const paneId = crypto.randomUUID()
    setSessions((prev) => ({
      ...prev,
      [paneId]: { paneId, cwd: opts.cwd, title: null, status: 'starting', launch: opts }
    }))
    setLayout((prev) => addPane(prev, paneId, dir))
  }, [])

  /** Un riquadro largo si divide in verticale, uno alto in orizzontale. */
  const naturalSplit = useCallback((paneId: string | null): SplitDir => {
    const rect = paneId ? rectsRef.current[paneId] : null
    if (!rect) return 'h'
    return rect.w >= rect.h ? 'h' : 'v'
  }, [])

  const newSessionHere = useCallback(
    (dir?: SplitDir) => {
      const focused = layoutRef.current.focused
      const cwd = (focused ? sessionsRef.current[focused]?.cwd : null) ?? config?.defaultCwd
      if (!cwd) return
      newSession(
        {
          cwd,
          model: config?.launchDefaults.model,
          effort: config?.launchDefaults.effort,
          permissionMode: config?.launchDefaults.permissionMode,
          // Il nome compare nel prompt box di Claude e in
          // ~/.claude/sessions/<pid>.json: serve a riconoscere la sessione.
          name: basename(cwd)
        },
        dir ?? naturalSplit(focused)
      )
    },
    [config, newSession, naturalSplit]
  )

  const closePane = useCallback((paneId: string) => {
    setLayout((prev) => removePane(prev, paneId))
    setSessions((prev) => {
      const next = { ...prev }
      delete next[paneId]
      return next
    })
    void destroySession(paneId)
  }, [])

  const onSlotReady = useCallback(
    (paneId: string, slot: HTMLDivElement) => {
      const meta = sessionsRef.current[paneId]
      if (!meta || isStarted(paneId)) return
      void ensureSession(paneId, slot, meta.launch)
        .then((result) =>
          patchSession(paneId, {
            status: 'running',
            // Serve a correlare il riquadro col registro delle sessioni vive.
            claudeSessionId: result?.claudeSessionId || null
          })
        )
        .catch((err: unknown) =>
          patchSession(paneId, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err)
          })
        )
    },
    [patchSession]
  )

  // --- Azioni da tastiera ---------------------------------------------------

  const focusDir = useCallback((dir: Direction) => {
    const current = layoutRef.current.focused
    if (!current) return
    const rects = rectsRef.current
    const panes = allPanes(layoutRef.current).map((id) => ({
      id,
      ...(rects[id] ?? { x: 0, y: 0, w: 0, h: 0 }),
      floating: isFloating(layoutRef.current, id),
      hidden: false,
      z: 0
    }))
    const target = paneInDirection(panes, current, dir)
    if (target) setLayout((prev) => setFocus(prev, target))
  }, [])

  const movePane = useCallback((dir: Direction) => {
    const current = layoutRef.current.focused
    if (!current) return
    const rects = rectsRef.current
    const tiled = collectLeaves(layoutRef.current.root)
    if (!tiled.includes(current)) return

    const panes = tiled.map((id) => ({
      id,
      ...(rects[id] ?? { x: 0, y: 0, w: 0, h: 0 }),
      floating: false,
      hidden: false,
      z: 0
    }))
    const target = paneInDirection(panes, current, dir)
    if (target) setLayout((prev) => swapPanes(prev, current, target))
  }, [])

  const runAction = useCallback(
    (action: Action) => {
      const focused = layoutRef.current.focused

      switch (action) {
        case 'new-session':
          setSelectorOpen(true)
          return
        case 'new-session-here':
          newSessionHere()
          return
        case 'split-h':
          newSessionHere('h')
          return
        case 'split-v':
          newSessionHere('v')
          return
        case 'close-pane':
          if (focused) closePane(focused)
          return
        case 'toggle-float': {
          if (!focused) return
          const rect = rectsRef.current[focused]
          if (!rect) return
          // Passando a flottante si rimpicciolisce un po', così si vede subito
          // che il riquadro si è staccato dal mosaico.
          const target = isFloating(layoutRef.current, focused)
            ? rect
            : { x: rect.x + 24, y: rect.y + 24, w: Math.max(320, rect.w * 0.7), h: Math.max(200, rect.h * 0.7) }
          setLayout((prev) => toggleFloat(prev, focused, target))
          return
        }
        case 'toggle-zoom':
          if (focused) setLayout((prev) => toggleZoom(prev, focused))
          return
        case 'focus-left':
          focusDir('left')
          return
        case 'focus-right':
          focusDir('right')
          return
        case 'focus-up':
          focusDir('up')
          return
        case 'focus-down':
          focusDir('down')
          return
        case 'move-left':
          movePane('left')
          return
        case 'move-right':
          movePane('right')
          return
        case 'move-up':
          movePane('up')
          return
        case 'move-down':
          movePane('down')
          return
        case 'toggle-fullscreen':
          window.cm.win.toggleFullscreen()
          return
        case 'toggle-devtools':
          window.cm.win.toggleDevTools()
          return
        case 'quit':
          window.cm.win.quit()
          return
        case 'toggle-usage':
          // Arriva con M5.
          return
        default: {
          const match = /^focus-([1-9])$/.exec(action)
          if (match) {
            const target = allPanes(layoutRef.current)[Number(match[1]) - 1]
            if (target) setLayout((prev) => setFocus(prev, target))
          }
        }
      }
    },
    [closePane, focusDir, movePane, newSessionHere]
  )

  // --- Effetti --------------------------------------------------------------

  useEffect(() => wireTerminalEvents(), [])

  useEffect(() => {
    setSessionEvents({
      onExit: (paneId) => patchSession(paneId, { status: 'exited' }),
      onTitle: (paneId, title) => patchSession(paneId, { title: title || null })
    })
    return () => setSessionEvents(null)
  }, [patchSession])

  /**
   * Lo stato dei riquadri viene dal registro che Claude Code stesso mantiene
   * in ~/.claude/sessions/: è autorevole e non richiede di interpretare
   * l'output del terminale. Una sessione ancora assente dal registro (Claude
   * sta partendo, o è fermo al dialogo di fiducia) resta 'running': assente
   * non vuol dire morta.
   */
  const applyLive = useCallback(
    (liveSessions: LiveSession[]) => {
      const byId = new Map(liveSessions.map((s) => [s.sessionId, s]))
      setSessions((prev) => {
        let changed = false
        const next: Record<string, SessionMeta> = {}

        for (const [paneId, meta] of Object.entries(prev)) {
          // Un riquadro la cui shell è morta non torna vivo per un record
          // rimasto indietro nel registro.
          if (meta.status === 'exited' || meta.status === 'error' || !meta.claudeSessionId) {
            next[paneId] = meta
            continue
          }

          const live = byId.get(meta.claudeSessionId)
          const status = live ? paneStatusFromLive(live.status) : meta.status
          const waitingFor = live?.waitingFor ?? null

          if (status !== meta.status || waitingFor !== (meta.waitingFor ?? null)) {
            next[paneId] = { ...meta, status, waitingFor }
            changed = true
          } else {
            next[paneId] = meta
          }
        }

        return changed ? next : prev
      })
    },
    []
  )

  useEffect(() => {
    void window.cm.claude.live().then(applyLive)
    return window.cm.claude.onLiveChange(applyLive)
  }, [applyLive])

  // Con il selettore aperto il compositor non intercetta nulla: le frecce e
  // l'Invio devono restare all'overlay, che gestisce da sé anche Esc.
  useEffect(
    () => installKeyHandler({ isEnabled: () => !selectorOpenRef.current, onAction: runAction }),
    [runAction]
  )

  // Il fuoco della tastiera segue il riquadro attivo, ma non glielo si ruba
  // mentre il selettore è aperto: scriverebbe nel terminale sottostante.
  useEffect(() => {
    if (layout.focused && !selectorOpen) focusPane(layout.focused)
  }, [layout.focused, selectorOpen])

  // Prima sessione all'avvio.
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void window.cm.config.get().then((cfg) => {
      setConfig(cfg)
      newSession(
        {
          cwd: cfg.defaultCwd,
          model: cfg.launchDefaults.model,
          effort: cfg.launchDefaults.effort,
          permissionMode: cfg.launchDefaults.permissionMode,
          name: basename(cfg.defaultCwd)
        },
        'h'
      )
    })
  }, [newSession])

  const paneCount = allPanes(layout).length

  return (
    <div className="cm-desktop">
      <header className="cm-topbar">
        <span className="cm-topbar__brand">ClaudeManager</span>
        <span className="cm-topbar__count">
          {paneCount} {paneCount === 1 ? 'sessione' : 'sessioni'}
        </span>
        <span className="cm-topbar__hint">
          <span className="cm-kbd">Alt+N</span> nuova ·{' '}
          <span className="cm-kbd">Alt+←→↑↓</span> fuoco ·{' '}
          <span className="cm-kbd">Alt+F</span> flottante ·{' '}
          <span className="cm-kbd">Alt+Z</span> zoom ·{' '}
          <span className="cm-kbd">Alt+W</span> chiudi
        </span>
        <div className="cm-topbar__spacer" />
        <div className="cm-topbar__buttons">
          <button className="cm-iconbtn" title="Riduci a icona" onClick={() => window.cm.win.minimize()}>
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

      <Desktop
        layout={layout}
        sessions={sessions}
        onFocusPane={(id) => setLayout((prev) => setFocus(prev, id))}
        onClosePane={closePane}
        onSlotReady={onSlotReady}
        onSetRatio={(path, ratio) => setLayout((prev) => setRatio(prev, path, ratio))}
        onMoveFloating={(id, x, y) => setLayout((prev) => updateFloating(prev, id, { x, y }))}
        onResizeFloating={(id, w, h) => setLayout((prev) => updateFloating(prev, id, { w, h }))}
        onRectsChange={(rects) => {
          rectsRef.current = rects
        }}
      />

      {selectorOpen && config && (
        <Selector
          defaults={config.launchDefaults}
          startPath={
            (layout.focused ? sessions[layout.focused]?.cwd : null) ?? config.defaultCwd
          }
          onCancel={() => setSelectorOpen(false)}
          onOpen={(opts) => {
            setSelectorOpen(false)
            newSession(opts, naturalSplit(layout.focused))
          }}
        />
      )}
    </div>
  )
}
