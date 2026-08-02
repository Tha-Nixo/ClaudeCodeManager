import { useEffect, useState } from 'react'
import type { AppConfig, MonitorState } from '@shared/types'
import { applyTheme } from '../theme/apply'
import { MonitorPanel } from './MonitorPanel'

/**
 * Radice della finestra staccata.
 *
 * Vive in un processo di rendering suo, quindi non eredita niente dalla
 * finestra principale: deve applicarsi il tema da sola, leggendolo dalla
 * stessa configurazione. Senza questo comparirebbe con i colori del foglio di
 * stile non ancora sovrascritti — cioè quelli di un tema che l'utente
 * potrebbe non usare.
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
      {/* L'intestazione è l'unica zona trascinabile: il resto deve restare
          cliccabile, e un'area di trascinamento troppo grande impedirebbe di
          selezionare un riquadro. */}
      <header className="cm-monitorwin__head">
        <span className="cm-drawer__title">ClaudeManager</span>
        <span className="cm-usage__spacer" />
        <button
          className="cm-iconbtn cm-monitorwin__btn"
          title="Riporta il pannello nella finestra principale"
          onClick={() => void window.cm.monitor.attach()}
        >
          ⇤
        </button>
      </header>

      <MonitorPanel state={state} />
    </div>
  )
}
