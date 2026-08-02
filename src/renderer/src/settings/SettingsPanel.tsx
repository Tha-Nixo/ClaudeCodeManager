import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, IndexKind, IndexStatus, UpdateState } from '@shared/types'
import type { Theme, ThemeLoadError } from '@shared/theme'
import type { KeymapProblem } from '../keys/bindings'
import { KeymapEditor } from './KeymapEditor'

interface SettingsPanelProps {
  config: AppConfig
  onConfigChange: (config: AppConfig) => void
  onClose: () => void
  /** Scorciatoie scartate dalla configurazione, da mostrare in chiaro. */
  keymapProblems: KeymapProblem[]
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
  onClose,
  keymapProblems
}: SettingsPanelProps): React.JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, IndexStatus>>({})
  const [rootsText, setRootsText] = useState(config.scanRoots.join('\n'))
  const [catalog, setCatalog] = useState<Theme[]>([])
  const [themeErrors, setThemeErrors] = useState<ThemeLoadError[]>([])

  useEffect(() => {
    // Il catalogo si rilegge ad ogni apertura: cosi' un file appena messo
    // nella cartella compare senza dover riavviare l'app.
    void window.cm.theme.catalog().then((c) => {
      setCatalog(c.themes)
      setThemeErrors(c.errors)
    })
  }, [])

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
          {/* In cima perche' la pastiglia della barra porta qui: se la sezione
              fosse in fondo, chi la preme troverebbe il pannello all'inizio e
              dovrebbe cercarsi da solo quello che ha appena chiesto. */}
          <UpdateSection />

          <section className="cm-settings__section">
            <div className="cm-settings__row">
              <span className="cm-field__label">Tema</span>
              <button className="cm-chip" onClick={() => void window.cm.theme.openDir()}>
                Apri la cartella dei temi
              </button>
            </div>

            <div className="cm-themes">
              {catalog.map((theme) => (
                <button
                  key={theme.id}
                  className={`cm-theme ${theme.id === config.themeId ? 'cm-theme--on' : ''}`}
                  onClick={() => patch({ themeId: theme.id })}
                  title={theme.source ?? 'tema integrato'}
                >
                  <span className="cm-theme__swatches">
                    {[
                      theme.ui.desktop,
                      theme.ui.panel,
                      theme.terminal.background,
                      theme.ui.accent,
                      theme.ui.text,
                      theme.terminal.ansi[2],
                      theme.terminal.ansi[4],
                      theme.terminal.ansi[5]
                    ].map((c, i) => (
                      <span key={i} className="cm-theme__swatch" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="cm-theme__name">
                    {theme.name}
                    {theme.custom && <span className="cm-theme__tag">tuo</span>}
                  </span>
                  {theme.description && (
                    <span className="cm-theme__desc">{theme.description}</span>
                  )}
                </button>
              ))}
            </div>

            {themeErrors.length > 0 && (
              <div className="cm-theme__errors">
                {themeErrors.map((e) => (
                  <div key={e.file}>
                    <strong>{e.file}</strong> — {e.error}
                  </div>
                ))}
              </div>
            )}
          </section>

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
            <label className="cm-settings__check">
              <input
                type="checkbox"
                checked={config.notifyOnWaiting}
                onChange={(e) => patch({ notifyOnWaiting: e.target.checked })}
              />
              Avvisa quando una sessione attende una risposta
            </label>
            <div className="cm-source__detail">
              Solo quando la finestra non ha il fuoco. L&apos;icona nella barra delle
              applicazioni lampeggia comunque, anche a notifiche spente.
            </div>
          </section>

          <KeymapEditor config={config} onPatch={patch} problems={keymapProblems} />

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

/**
 * Versione in esecuzione e stato degli aggiornamenti.
 *
 * Il pulsante che riavvia è volutamente separato e chiede conferma: installare
 * significa chiudere l'app, e con essa ogni sessione Claude aperta.
 */
function UpdateSection(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void window.cm.update.version().then(setVersion)
    void window.cm.update.state().then(setState)
    return window.cm.update.onChange(setState)
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    setState(await window.cm.update.check())
    setChecking(false)
  }

  const status = state?.status ?? 'idle'

  return (
    <section className="cm-settings__section">
      <div className="cm-settings__row">
        <span className="cm-field__label">Versione</span>
        <span className="cm-update__version">{version || '…'}</span>
        <span className="cm-usage__spacer" />
        {status !== 'unsupported' && (
          <button className="cm-chip" disabled={checking} onClick={() => void check()}>
            {checking || status === 'checking' ? 'Controllo…' : 'Controlla aggiornamenti'}
          </button>
        )}
      </div>

      <div className="cm-source__detail">
        {status === 'unsupported' && state?.message}
        {status === 'idle' &&
          (state?.checkedAt
            ? `Nessun aggiornamento disponibile · controllato ${relative(state.checkedAt)}`
            : 'Il controllo avviene da solo poco dopo l’avvio e poi una volta al giorno.')}
        {status === 'checking' && 'Controllo in corso…'}
        {status === 'downloading' &&
          `Scaricamento della versione ${state?.version} · ${state?.percent ?? 0}%`}
        {status === 'error' && `Controllo non riuscito: ${state?.message}`}
        {status === 'available' && (
          <>
            È uscita la versione <strong>{state?.version}</strong>. {state?.message}
          </>
        )}
        {status === 'ready' && (
          <>
            La versione <strong>{state?.version}</strong> è pronta. Verrà installata da sola alla
            chiusura dell’app.
          </>
        )}
      </div>

      {/* React lo rende come testo, e dal main arriva gia' ripulito dall'HTML. */}
      {state?.notes && (status === 'available' || status === 'ready') && (
        <div className="cm-update__notes">{state.notes}</div>
      )}

      {status === 'available' && (
        <div className="cm-source__actions">
          <span className="cm-source__progress">
            Chiudi ClaudeManager prima di sostituire il file: un eseguibile in uso non si può
            rimpiazzare.
          </span>
          <button className="cm-chip" onClick={() => void window.cm.update.openRelease()}>
            Vai alla versione {state?.version}
          </button>
        </div>
      )}

      {status === 'ready' && (
        <div className="cm-source__actions">
          {confirming ? (
            <>
              <span className="cm-source__progress">
                Il riavvio chiude tutte le sessioni aperte. Procedere?
              </span>
              <button className="cm-chip" onClick={() => setConfirming(false)}>
                No
              </button>
              <button className="cm-chip" onClick={() => void window.cm.update.install()}>
                Riavvia e installa
              </button>
            </>
          ) : (
            <button className="cm-chip" onClick={() => setConfirming(true)}>
              Installa adesso
            </button>
          )}
        </div>
      )}
    </section>
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
