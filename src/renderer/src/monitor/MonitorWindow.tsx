import { useEffect, useState } from 'react'
import type { AppConfig, MonitorState } from '@shared/types'
import { applyTheme } from '../theme/apply'
import { MonitorPanel } from './MonitorPanel'

/**
 * Root of the detached window.
 *
 * Runs in its own renderer process, so it inherits nothing from the
 * main window: it must apply the theme itself, reading it from config.
 * Without this, default fallback stylesheet colors would flash.
 */
export default function MonitorWindow(): React.JSX.Element {
  const [state, setState] = useState<MonitorState | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)

  useEffect(() => {
    void window.cm.monitor.subscribe().then(setState)
    const off = window.cm.monitor.onState(setState)
    return () => {
      off()
      window.cm.monitor.unsubscribe()
    }
  }, [])

  useEffect(() => {
    void window.cm.config.get().then(setConfig)
  }, [])

  useEffect(() => {
    if (!config) return
    void window.cm.theme.catalog().then((catalog) => {
      const theme = catalog.themes.find((t) => t.id === config.themeId) ?? catalog.themes[0]
      if (theme) applyTheme(theme)
    })
  }, [config])

  return (
    <div className="cm-monitorwin">
      {/* The header is the only draggable region: the rest must remain
          clickable, and an overly large drag area would prevent selecting a pane. */}
      <header className="cm-monitorwin__head">
        <span className="cm-drawer__title">ClaudeManager</span>
        <span className="cm-usage__spacer" />
        <button
          className="cm-iconbtn cm-monitorwin__btn"
          title="Reattach panel to main window"
          onClick={() => void window.cm.monitor.attach()}
        >
          ⇤
        </button>
      </header>

      <MonitorPanel state={state} />
    </div>
  )
}
