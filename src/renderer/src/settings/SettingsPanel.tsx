import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, IndexKind, IndexStatus } from '@shared/types'

interface SettingsPanelProps {
  config: AppConfig
  onConfigChange: (config: AppConfig) => void
  onClose: () => void
}

const SOURCES: {
  key: keyof AppConfig['indexSources']
  kind: IndexKind | null
  title: string
  detail: string
  heavy?: boolean
}[] = [
  {
    key: 'claude',
    kind: null,
    title: 'Cartelle già usate con Claude',
    detail: 'Da history.jsonl e dai transcript. Nessuna scansione del disco, sempre aggiornata.'
  },
  {
    key: 'git',
    kind: 'git',
    title: 'Repository git',
    detail: 'Si ferma alla prima cartella con .git dentro le radici configurate.'
  },
  {
    key: 'roots',
    kind: 'roots',
    title: 'Radici configurate',
    detail: 'Tutte le sottocartelle fino a 3 livelli dentro le radici configurate.'
  },
  {
    key: 'drive',
    kind: 'drive',
    title: 'Unità complete',
    detail:
      'Scansione di tutte le unità. La prima esecuzione può richiedere minuti; ' +
      'sono escluse Windows, Program Files, AppData, node_modules e simili.',
    heavy: true
  }
]

export function SettingsPanel({
  config,
  onConfigChange,
  onClose
}: SettingsPanelProps): React.JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, IndexStatus>>({})
  const [rootsText, setRootsText] = useState(config.scanRoots.join('\n'))

  useEffect(() => {
    void window.cm.index.status().then((list) => {
      setStatuses(Object.fromEntries(list.map((s) => [s.kind, s])))
    })
    return window.cm.index.onProgress((s) => {
      setStatuses((prev) => ({ ...prev, [s.kind]: s }))
    })
  }, [])

  const patch = useCallback(
    (next: Partial<AppConfig>) => {
      void window.cm.config.set(next).then(onConfigChange)
    },
    [onConfigChange]
  )

  const toggleSource = useCallback(
    (key: keyof AppConfig['indexSources'], value: boolean) => {
      patch({ indexSources: { ...config.indexSources, [key]: value } })
    },
    [config.indexSources, patch]
  )

  const commitRoots = useCallback(() => {
    const roots = rootsText
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
    patch({ scanRoots: roots })
  }, [rootsText, patch])

  return (
    <div className="cm-overlay" onPointerDown={onClose}>
      <div className="cm-settings" onPointerDown={(e) => e.stopPropagation()}>
        <header className="cm-usage__head">
          <span className="cm-usage__title">Impostazioni</span>
          <span className="cm-usage__spacer" />
          <button className="cm-iconbtn" onClick={onClose} title="Chiudi (Esc)">
            ✕
          </button>
        </header>

        <div className="cm-settings__body">
          <section className="cm-settings__section">
            <div className="cm-field__label">Cartella di partenza</div>
            <input
              className="cm-selector__prompt"
              value={config.defaultCwd}
              spellCheck={false}
              onChange={(e) => onConfigChange({ ...config, defaultCwd: e.target.value })}
              onBlur={(e) => patch({ defaultCwd: e.target.value.trim() })}
            />
            <label className="cm-settings__check">
              <input
                type="checkbox"
                checked={config.restoreResumesSessions}
                onChange={(e) => patch({ restoreResumesSessions: e.target.checked })}
              />
              Al ripristino riprendi anche le conversazioni, non solo le cartelle
            </label>
          </section>

          <section className="cm-settings__section">
            <div className="cm-field__label">Radici da indicizzare</div>
            <textarea
              className="cm-settings__roots"
              value={rootsText}
              spellCheck={false}
              rows={4}
              placeholder={'Un percorso per riga\nC:\\Users\\...\\Desktop'}
              onChange={(e) => setRootsText(e.target.value)}
              onBlur={commitRoots}
            />
          </section>

          <section className="cm-settings__section">
            <div className="cm-field__label">Sorgenti del selettore</div>
            {SOURCES.map((source) => {
              const status = source.kind ? statuses[source.kind] : null
              const enabled = config.indexSources[source.key]
              return (
                <div key={source.key} className="cm-source">
                  <label className="cm-settings__check">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => toggleSource(source.key, e.target.checked)}
                    />
                    <span className={source.heavy ? 'cm-source__title cm-source__title--heavy' : 'cm-source__title'}>
                      {source.title}
                    </span>
                  </label>
                  <div className="cm-source__detail">{source.detail}</div>

                  {source.kind && (
                    <div className="cm-source__actions">
                      {status?.running ? (
                        <>
                          <span className="cm-source__progress">
                            {status.visited.toLocaleString('it-IT')} cartelle visitate ·{' '}
                            {status.found.toLocaleString('it-IT')} trovate
                            {status.current ? ` · ${status.current}` : ''}
                          </span>
                          <button
                            className="cm-chip"
                            onClick={() => window.cm.index.cancel(source.kind as IndexKind)}
                          >
                            Annulla
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="cm-source__progress">
                            {status?.scannedAt
                              ? `${status.found.toLocaleString('it-IT')} cartelle · ${relative(status.scannedAt)}`
                              : 'mai eseguita'}
                          </span>
                          <button
                            className="cm-chip"
                            onClick={() => void window.cm.index.rescan(source.kind as IndexKind)}
                          >
                            {status?.scannedAt ? 'Riscansiona' : 'Scansiona'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        </div>

        <footer className="cm-usage__foot">
          Le impostazioni sono salvate in <code>%APPDATA%\claudemanager\config.json</code> e possono
          essere modificate anche a mano.
        </footer>
      </div>
    </div>
  )
}

function relative(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'appena aggiornata'
  if (minutes < 60) return `${minutes} min fa`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h fa`
  return `${Math.round(hours / 24)} g fa`
}
