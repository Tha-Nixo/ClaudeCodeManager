import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig, LaunchOptions, LiveSession, UpdateState } from '@shared/types'
import { Desktop } from './compositor/Desktop'
import type { Rect } from './compositor/geometry'
import { paneInDirection } from './compositor/geometry'
import {
  EMPTY_LAYOUT,
  addPane,
  allPanes,
  collectLeaves,
  isFloating,
  movePaneTo,
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
import { SettingsPanel } from './settings/SettingsPanel'
import { fromPersisted, toPersisted } from './state/persistence'
import { paneStatusFromLive, type SessionMeta } from './state/types'
import { applyTheme } from './theme/apply'
import { UsagePanel, formatCost, formatTokens } from './usage/UsagePanel'
import { basename, isUsefulTitle } from './util/path'
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
  const [usageOpen, setUsageOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageBadge, setUsageBadge] = useState<{ cost: number; tokens: number } | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)

  // Un overlay aperto disattiva le scorciatoie del compositor. Il ref serve
  // perché il gestore tastiera è registrato una volta sola e non vedrebbe
  // i valori aggiornati dello stato.
  const overlayOpenRef = useRef(false)
  overlayOpenRef.current = selectorOpen || usageOpen || settingsOpen

  // Geometrie correnti dei riquadri. Sono un ref e non uno stato: servono solo
  // dentro i gestori (focus direzionale, passaggio a flottante) e non devono
  // provocare render.
  const rectsRef = useRef<Record<string, Rect>>({})
  const layoutRef = useRef(layout)
  const sessionsRef = useRef(sessions)
  layoutRef.current = layout
  sessionsRef.current = sessions

  const bootstrapped = useRef(false)
  /** Alzato quando il ripristino ha finito: da lì in poi si può salvare. */
  const restoreDone = useRef(false)

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
      void ensureSession(paneId, slot, meta.launch, {
        shouldFocus: () => layoutRef.current.focused === paneId
      })
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

  /**
   * Riquadri con la geometria corrente, per il calcolo del vicino.
   *
   * Il flag `hidden` deve riflettere lo zoom: sotto zoom gli altri riquadri
   * conservano il proprio rettangolo (per non innescare un resize del PTY),
   * quindi senza questo il fuoco si sposterebbe su un riquadro invisibile e
   * un Alt+W successivo chiuderebbe una sessione che l'utente non vede.
   */
  const paneRects = useCallback(() => {
    const layout = layoutRef.current
    const rects = rectsRef.current
    return allPanes(layout).map((id) => ({
      id,
      ...(rects[id] ?? { x: 0, y: 0, w: 0, h: 0 }),
      floating: isFloating(layout, id),
      hidden: layout.zoomed !== null && id !== layout.zoomed,
      z: 0
    }))
  }, [])

  const focusDir = useCallback(
    (dir: Direction) => {
      const current = layoutRef.current.focused
      if (!current) return
      const target = paneInDirection(paneRects(), current, dir)
      if (target) setLayout((prev) => setFocus(prev, target))
    },
    [paneRects]
  )

  const movePane = useCallback(
    (dir: Direction) => {
      const layout = layoutRef.current
      const current = layout.focused
      if (!current) return
      const tiled = collectLeaves(layout.root)
      if (!tiled.includes(current)) return
      // Scambiare di posto due riquadri mentre uno zoom nasconde tutto non
      // produce nulla di visibile: si rimanderebbe l'effetto all'uscita.
      if (layout.zoomed !== null) return

      const target = paneInDirection(
        paneRects().filter((p) => tiled.includes(p.id)),
        current,
        dir
      )
      if (target) setLayout((prev) => swapPanes(prev, current, target))
    },
    [paneRects]
  )

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
          setUsageOpen((open) => !open)
          return
        case 'toggle-settings':
          setSettingsOpen((open) => !open)
          return
        default: {
          const match = /^focus-([1-9])$/.exec(action)
          if (match) {
            const target = allPanes(layoutRef.current)[Number(match[1]) - 1]
            if (!target) return
            setLayout((prev) =>
              // Saltare a un riquadro nascosto dallo zoom non mostrerebbe
              // nulla: si esce dallo zoom, che è ciò che l'utente intende.
              setFocus(prev.zoomed !== null && prev.zoomed !== target ? { ...prev, zoomed: null } : prev, target)
            )
          }
        }
      }
    },
    [closePane, focusDir, movePane, newSessionHere]
  )

  // --- Effetti --------------------------------------------------------------

  // Il tema si applica appena la configurazione arriva e a ogni cambio.
  // Il catalogo viene riletto ogni volta perché un tema personale può essere
  // stato modificato sul disco mentre l'app era aperta.
  useEffect(() => {
    if (!config) return
    void window.cm.theme.catalog().then((catalog) => {
      const theme =
        catalog.themes.find((t) => t.id === config.themeId) ?? catalog.themes[0]
      if (theme) applyTheme(theme)
    })
  }, [config?.themeId, config])

  useEffect(() => wireTerminalEvents(), [])

  useEffect(() => {
    setSessionEvents({
      onExit: (paneId) => patchSession(paneId, { status: 'exited' }),
      onTitle: (paneId, title) =>
        patchSession(paneId, { title: isUsefulTitle(title) ? title.trim() : null })
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
          // Sparita dal registro significa che quel processo claude è finito
          // (tipicamente con /exit, lasciando viva la shell). Conservare
          // l'ultimo stato lascerebbe il riquadro "al lavoro" per sempre:
          // la shell c'è ancora, quindi lo stato giusto è "pronta".
          const status = live ? paneStatusFromLive(live.status) : 'running'
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

  // Con un overlay aperto il compositor non intercetta nulla: le frecce e
  // l'Invio devono restare all'overlay.
  useEffect(
    () => installKeyHandler({ isEnabled: () => !overlayOpenRef.current, onAction: runAction }),
    [runAction]
  )

  // Esc chiude gli overlay. Il selettore lo gestisce da sé perché ha il fuoco
  // sul proprio campo di ricerca; gli altri pannelli no, quindi serve qui.
  useEffect(() => {
    if (!usageOpen && !settingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setUsageOpen(false)
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [usageOpen, settingsOpen])

  // Il fuoco della tastiera segue il riquadro attivo, ma non glielo si ruba
  // mentre il selettore è aperto: scriverebbe nel terminale sottostante.
  useEffect(() => {
    if (layout.focused && !selectorOpen) focusPane(layout.focused)
  }, [layout.focused, selectorOpen])

  // Avvio: si prova a ripristinare il layout precedente, altrimenti si apre
  // una sessione sulla cartella predefinita.
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true

    void (async () => {
      let cfg: AppConfig | null = null
      try {
        cfg = await window.cm.config.get()
        setConfig(cfg)

        const stored = await window.cm.layout.load()
        const restored = stored ? fromPersisted(stored, cfg) : null

        if (restored) {
          setSessions(restored.sessions)
          setLayout(restored.layout)
          return
        }
      } catch (err) {
        // Un layout.json corrotto o un canale che fallisce non devono lasciare
        // l'app su uno stage vuoto: si ricade sulla sessione predefinita.
        console.error('ripristino fallito, avvio sulla cartella predefinita', err)
      } finally {
        restoreDone.current = true
      }

      const fallback = cfg ?? (await window.cm.config.get().catch(() => null))
      if (!fallback) return

      newSession(
        {
          cwd: fallback.defaultCwd,
          model: fallback.launchDefaults.model,
          effort: fallback.launchDefaults.effort,
          permissionMode: fallback.launchDefaults.permissionMode,
          name: basename(fallback.defaultCwd)
        },
        'h'
      )
    })()
  }, [newSession])

  // Salvataggio del layout ad ogni cambiamento. Il main accorpa le scritture,
  // quindi trascinare un canale non produce decine di scritture su disco.
  useEffect(() => {
    // La guardia vale solo finché il ripristino non è concluso: un salvataggio
    // durante quella finestra cancellerebbe il file che si sta leggendo. Dopo,
    // anche "nessun riquadro" è uno stato legittimo da persistere, altrimenti
    // chiudere tutti i riquadri e uscire riaprirebbe quelli di prima.
    if (!restoreDone.current) return
    window.cm.layout.save(toPersisted(layout, sessions))
  }, [layout, sessions])

  // Costo di oggi nella barra superiore. La scansione è incrementale, quindi
  // un aggiornamento al minuto costa quasi nulla.
  useEffect(() => {
    const refresh = (): void => {
      void window.cm.usage
        .summary()
        .then((s) => setUsageBadge({ cost: s.todayCost, tokens: s.todayTokens }))
    }
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => clearInterval(id)
  }, [])

  // Lo stato degli aggiornamenti arriva dal main, che possiede il controllo.
  useEffect(() => {
    void window.cm.update.state().then(setUpdate)
    return window.cm.update.onChange(setUpdate)
  }, [])

  const paneCount = allPanes(layout).length

  return (
    <div className="cm-desktop">
      <header className="cm-topbar">
        <span className="cm-topbar__brand">ClaudeManager</span>
        <span className="cm-topbar__count">
          {paneCount} {paneCount === 1 ? 'sessione' : 'sessioni'}
        </span>
        {usageBadge && (
          <button
            className="cm-topbar__usage"
            title="Utilizzo di oggi · Alt+U per il dettaglio"
            onClick={() => setUsageOpen(true)}
          >
            {formatCost(usageBadge.cost)} oggi · {formatTokens(usageBadge.tokens)} tok
          </button>
        )}
        {update && (update.status === 'ready' || update.status === 'downloading') && (
          <button
            className={`cm-topbar__update ${update.status === 'ready' ? 'cm-topbar__update--ready' : ''}`}
            title={
              update.status === 'ready'
                ? `La versione ${update.version} è pronta. Verrà installata alla chiusura, oppure premi qui per riavviare adesso.`
                : 'Scaricamento del nuovo aggiornamento in corso'
            }
            onClick={() => {
              // Riavviare chiude tutte le sessioni: va chiesto, non fatto e basta.
              if (update.status === 'ready') setSettingsOpen(true)
            }}
          >
            {update.status === 'ready'
              ? `↑ ${update.version} pronta`
              : `↓ ${update.percent ?? 0}%`}
          </button>
        )}
        <span className="cm-topbar__hint">
          <span className="cm-kbd">Alt+N</span> nuova ·{' '}
          <span className="cm-kbd">Alt+←→↑↓</span> fuoco ·{' '}
          <span className="cm-kbd">Alt+F</span> flottante ·{' '}
          <span className="cm-kbd">Alt+Z</span> zoom ·{' '}
          <span className="cm-kbd">Alt+W</span> chiudi
        </span>
        <div className="cm-topbar__spacer" />
        <div className="cm-topbar__buttons">
          <button
            className="cm-iconbtn"
            title="Impostazioni (Alt+,)"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
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
        onDropPane={(movingId, targetId, side) =>
          setLayout((prev) => movePaneTo(prev, movingId, targetId, side))
        }
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

      {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}

      {settingsOpen && config && (
        <SettingsPanel
          config={config}
          onConfigChange={setConfig}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
