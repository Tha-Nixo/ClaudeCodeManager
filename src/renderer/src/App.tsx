import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, LaunchOptions, LiveSession, UpdateState } from '@shared/types'
import { Desktop } from './compositor/Desktop'
import type { Rect } from './compositor/geometry'
import { MIN_PANE_H, MIN_PANE_W, canSplit, paneInDirection } from './compositor/geometry'
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
import { installKeyHandler, resolveKeymap, type Action } from './keys/bindings'
import { Selector } from './selector/Selector'
import { SettingsPanel } from './settings/SettingsPanel'
import { fromPersisted, toPersisted } from './state/persistence'
import { paneStatusFromLive, type SessionMeta } from './state/types'
import { applyTheme } from './theme/apply'
import { UsagePanel, formatCost, formatTokens } from './usage/UsagePanel'
import { basename, isUsefulTitle } from './util/path'
import { launchErrorMessage } from './util/ipcError'
import {
  destroySession,
  ensureSession,
  focusPane,
  isStarted,
  setFitSuspendedAll,
  setSessionEvents,
  wireTerminalEvents
} from './terminal/registry'
import { Drawer } from './monitor/Drawer'

/** Statuses that warrant a status bar badge: others require no user action. */
const UPDATE_VISIBLE = new Set(['available', 'downloading', 'ready'])

/** Must match the transition duration of .cm-drawer in stylesheet. */
const DRAWER_MS = 220

export default function App(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [layout, setLayout] = useState<Layout>(EMPTY_LAYOUT)
  const [sessions, setSessions] = useState<Record<string, SessionMeta>>({})
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageBadge, setUsageBadge] = useState<{ cost: number; tokens: number } | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detached, setDetached] = useState(false)
  /** Pane with open search bar, if any. */
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null)

  // An open overlay disables compositor shortcuts. Ref is needed because
  // keyboard handler is registered once and would otherwise close over stale state.
  const overlayOpenRef = useRef(false)
  // Search bar counts as an overlay: its text input must receive keystrokes,
  // and compositor handler runs in capture phase on window, so it would
  // otherwise intercept input beforehand.
  overlayOpenRef.current = selectorOpen || usageOpen || settingsOpen || searchPaneId !== null

  // Current pane geometries. Stored in a ref rather than state: only needed
  // inside event handlers (directional focus, float toggling) without triggering renders.
  const rectsRef = useRef<Record<string, Rect>>({})
  const layoutRef = useRef(layout)
  const sessionsRef = useRef(sessions)
  layoutRef.current = layout
  sessionsRef.current = sessions

  const bootstrapped = useRef(false)
  /** Set to true when restoration finishes: saving is enabled from this point forward. */
  const restoreDone = useRef(false)

  const patchSession = useCallback((paneId: string, patch: Partial<SessionMeta>) => {
    setSessions((prev) => (prev[paneId] ? { ...prev, [paneId]: { ...prev[paneId], ...patch } } : prev))
  }, [])

  // --- Session creation and cleanup -----------------------------------------

  const newSession = useCallback((opts: LaunchOptions, dir: SplitDir) => {
    const paneId = crypto.randomUUID()
    setSessions((prev) => ({
      ...prev,
      [paneId]: { paneId, cwd: opts.cwd, title: null, status: 'starting', launch: opts }
    }))

    setLayout((prev) => {
      const next = addPane(prev, paneId, dir)

      // Unbounded splitting produced 4px and then 0px panes: processes launched
      // and consumed tokens, but terminal was neither visible nor reachable.
      // When space is exhausted, the session spawns floating—small but usable—rather than invisible.
      const rect = prev.focused ? rectsRef.current[prev.focused] : null
      if (!rect || canSplit(rect, dir)) return next

      // Offset from origin pane so it does not directly overlap it.
      return toggleFloat(next, paneId, {
        x: Math.max(0, rect.x + 40),
        y: Math.max(0, rect.y + 40),
        w: Math.max(MIN_PANE_W * 3, 520),
        h: Math.max(MIN_PANE_H * 3, 360)
      })
    })
  }, [])

  /** A wide pane splits vertically, a tall pane splits horizontally. */
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
          // Name appears in Claude prompt box and ~/.claude/sessions/<pid>.json:
          // helps identify the session.
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
            // Correlates pane with live session registry.
            claudeSessionId: result?.claudeSessionId || null
          })
        )
        .catch((err: unknown) =>
          patchSession(paneId, { status: 'error', error: launchErrorMessage(err) })
        )
    },
    [patchSession]
  )

  // --- Keyboard actions -----------------------------------------------------

  /**
   * Panes with current geometry, for neighbor calculation.
   *
   * The `hidden` flag must reflect zoom: under zoom other panes retain
   * their bounds (to prevent triggering a PTY resize), so without this
   * focus would shift to an invisible pane and a subsequent Alt+W would
   * close a session the user cannot see.
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
      // Swapping two panes while zoom obscures everything produces no visible change:
      // it would defer the effect until exiting zoom.
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
          // Slightly shrink when converting to floating so it is immediately obvious
          // that the pane has detached from the tiling layout.
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
        case 'search-pane':
          // Search targets a specific terminal: without an active pane,
          // there is nothing to search.
          setSearchPaneId((current) => (current ? null : layoutRef.current.focused))
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
              // Jumping to a pane hidden by zoom would display nothing:
              // exit zoom mode first, matching user intent.
              setFocus(prev.zoomed !== null && prev.zoomed !== target ? { ...prev, zoomed: null } : prev, target)
            )
          }
        }
      }
    },
    [closePane, focusDir, movePane, newSessionHere]
  )

  // --- Effects ---------------------------------------------------------------

  // Theme applies as soon as config arrives and on every change.
  // Catalog is re-read each time because a custom theme may have been modified
  // on disk while the app remained running.
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
   * Pane status originates from the registry Claude Code maintains in
   * ~/.claude/sessions/: authoritative without parsing terminal stdout.
   * A session not yet present in the registry (Claude is starting, or waiting
   * at the trust prompt) remains 'running': absent does not mean exited.
   */
  const applyLive = useCallback(
    (liveSessions: LiveSession[]) => {
      const byId = new Map(liveSessions.map((s) => [s.sessionId, s]))
      setSessions((prev) => {
        let changed = false
        const next: Record<string, SessionMeta> = {}

        for (const [paneId, meta] of Object.entries(prev)) {
          // A pane whose shell has exited does not revive from a stale registry record.
          if (meta.status === 'exited' || meta.status === 'error' || !meta.claudeSessionId) {
            next[paneId] = meta
            continue
          }

          const live = byId.get(meta.claudeSessionId)
          // Disappeared from registry means that claude process ended
          // (typically via /exit, leaving the shell alive). Keeping last state
          // would leave the pane "working" forever: shell is still alive, so 'running' is correct.
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

  // Custom bindings overlay the default map. Recomputed only when changed:
  // reinstalling the event listener on every render is wasteful.
  const { keymap, problems: keymapProblems } = useMemo(
    () => resolveKeymap(config?.keymap, { devTools: window.cm.win.devToolsAllowed }),
    [config?.keymap]
  )

  // When an overlay is open, compositor intercepts nothing: arrow keys and Enter
  // belong to the overlay.
  useEffect(
    () =>
      installKeyHandler({
        keymap,
        isEnabled: () => !overlayOpenRef.current,
        onAction: runAction
      }),
    [runAction, keymap]
  )

  // Esc closes overlays. The selector manages this itself because it focuses its input;
  // other panels do not, so it is handled here.
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

  // Keyboard focus follows active pane, but is not stolen while selector is open:
  // otherwise keystrokes would route to the underlying terminal.
  useEffect(() => {
    if (layout.focused && !selectorOpen) focusPane(layout.focused)
  }, [layout.focused, selectorOpen])

  // Startup: attempts to restore previous layout, otherwise spawns a session in default directory.
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
        // A corrupt layout.json or failing channel must not leave the app
        // with an empty stage: fall back to default session.
        console.error('restore failed, starting with default directory', err)
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

  // Saves layout on every change. Main process debounces writes,
  // so dragging a gutter does not spam disk writes.
  useEffect(() => {
    // Guard applies only while restore is in progress: saving during that window
    // would overwrite the file being read. Afterwards, "no panes" is a valid state
    // to persist, otherwise closing all panes and exiting would resurrect them on next launch.
    if (!restoreDone.current) return
    window.cm.layout.save(toPersisted(layout, sessions))
  }, [layout, sessions])

  // Today's cost in top bar. Scanning is incremental, so updating once per minute is cheap.
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

  // Update state comes from main process, which manages checks.
  useEffect(() => {
    void window.cm.update.state().then(setUpdate)
    return window.cm.update.onChange(setUpdate)
  }, [])

  useEffect(() => {
    void window.cm.monitor.isDetached().then(setDetached)
    return window.cm.monitor.onDetachedChange(setDetached)
  }, [])

  // Clicking a notification lands on the session requesting input, not generically on app:
  // focus shifts to terminal so user can respond immediately without an extra click.
  useEffect(
    () =>
      window.cm.notify.onFocusPane((paneId) => {
        setLayout((prev) => setFocus(prev, paneId))
        focusPane(paneId)
      }),
    []
  )

  // Memoized: `allPanes` allocates a new array each call, which would re-trigger effects on every render.
  const paneOrder = useMemo(() => allPanes(layout), [layout])
  const paneCount = paneOrder.length

  /**
   * Panes live here, but monitoring panel can live in another window
   * without direct access to this state: published to main, which broadcasts to subscribers.
   * Sends only what monitor panel requires, not full SessionMeta.
   */
  useEffect(() => {
    window.cm.monitor.publish(
      paneOrder.map((paneId, i) => {
        const meta = sessions[paneId]
        const remote = meta?.launch.remote
        return {
          paneId,
          index: i + 1,
          label: meta?.title ?? basename(remote ? remote.path : (meta?.cwd ?? '')),
          where: remote ? `${remote.user}@${remote.host}:${remote.path}` : (meta?.cwd ?? ''),
          // A remote session writes state on the server: reporting "ready"
          // would be guesswork, as in the pane header.
          status: remote && meta?.status === 'running' ? 'remote' : (meta?.status ?? 'starting'),
          waitingFor: meta?.waitingFor ?? null,
          remote: Boolean(remote),
          claudeSessionId: meta?.claudeSessionId ?? null
        }
      })
    )
  }, [paneOrder, sessions])

  /**
   * Opening and closing drawer resizes stage, which would trigger compositor
   * ResizeObserver on every frame: causing a dozen pty.resize calls per gesture,
   * with Claude Code redrawing each time. Freeze measurement during transition,
   * matching layout animations.
   */
  useEffect(() => {
    setFitSuspendedAll(true)
    const id = setTimeout(() => setFitSuspendedAll(false), DRAWER_MS)
    return () => clearTimeout(id)
  }, [drawerOpen])

  return (
    <div className={`cm-desktop ${drawerOpen && !detached ? 'cm-desktop--drawer' : ''}`}>
      <header className="cm-topbar">
        <span className="cm-topbar__brand">ClaudeManager</span>
        <span className="cm-topbar__count">
          {paneCount} {paneCount === 1 ? 'session' : 'sessions'}
        </span>
        {usageBadge && (
          <button
            className="cm-topbar__usage"
            title="Today's usage · Alt+U for details"
            onClick={() => setUsageOpen(true)}
          >
            {formatCost(usageBadge.cost)} today · {formatTokens(usageBadge.tokens)} tok
          </button>
        )}
        {update && UPDATE_VISIBLE.has(update.status) && (
          <button
            className={`cm-topbar__update ${update.status === 'downloading' ? '' : 'cm-topbar__update--ready'}`}
            title={
              update.status === 'ready'
                ? `Version ${update.version} is ready. It will be installed on exit, or open Settings to restart now.`
                : update.status === 'available'
                  ? `Version ${update.version} is available. This portable build must be updated manually.`
                  : 'Downloading update...'
            }
            // No irreversible actions here: restarting terminates all sessions,
            // so clicking the badge opens Settings where the user can choose.
            onClick={() => update.status !== 'downloading' && setSettingsOpen(true)}
          >
            {update.status === 'downloading'
              ? `↓ ${update.percent ?? 0}%`
              : `↑ ${update.version} ${update.status === 'ready' ? 'ready' : 'available'}`}
          </button>
        )}
        <span className="cm-topbar__hint">
          <span className="cm-kbd">Alt+N</span> new ·{' '}
          <span className="cm-kbd">Alt+←→↑↓</span> focus ·{' '}
          <span className="cm-kbd">Alt+F</span> float ·{' '}
          <span className="cm-kbd">Alt+Z</span> zoom ·{' '}
          <span className="cm-kbd">Alt+W</span> close
        </span>
        <div className="cm-topbar__spacer" />
        <div className="cm-topbar__buttons">
          <button
            className="cm-iconbtn"
            title="Settings (Alt+,)"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
          <button className="cm-iconbtn" title="Minimize" onClick={() => window.cm.win.minimize()}>
            ─
          </button>
          <button
            className="cm-iconbtn"
            title="Fullscreen (F11)"
            onClick={() => window.cm.win.toggleFullscreen()}
          >
            ▢
          </button>
          <button
            className="cm-iconbtn cm-iconbtn--danger"
            title="Quit (Ctrl+Shift+Q)"
            onClick={() => window.cm.win.quit()}
          >
            ✕
          </button>
        </div>
      </header>

      <Drawer
        open={drawerOpen}
        onToggle={() => setDrawerOpen((v) => !v)}
        detached={detached}
        onDetach={() => void window.cm.monitor.detach()}
        onAttach={() => void window.cm.monitor.attach()}
        onFocusPane={(id) => setLayout((prev) => setFocus(prev, id))}
      />

      <Desktop
        layout={layout}
        sessions={sessions}
        onFocusPane={(id) => setLayout((prev) => setFocus(prev, id))}
        onClosePane={closePane}
        onReplacePane={(paneId) => {
          closePane(paneId)
          setSelectorOpen(true)
        }}
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
        searchPaneId={searchPaneId}
        onCloseSearch={() => setSearchPaneId(null)}
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
          keymapProblems={keymapProblems}
        />
      )}
    </div>
  )
}
