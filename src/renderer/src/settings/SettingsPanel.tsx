import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, IndexKind, IndexStatus, UpdateState } from '@shared/types'
import type { Theme, ThemeLoadError } from '@shared/theme'
import type { KeymapProblem } from '../keys/bindings'
import { KeymapEditor } from './KeymapEditor'

interface SettingsPanelProps {
  config: AppConfig
  onConfigChange: (config: AppConfig) => void
  onClose: () => void
  /** Ignored user keymap entries to display explicitly. */
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
    title: 'Folders previously used with Claude',
    detail: 'Parsed from history.jsonl and transcripts. No disk scanning, always up to date.'
  },
  {
    key: 'git',
    kind: 'git',
    title: 'Git repositories',
    detail: 'Stops at the first folder containing .git within configured roots.'
  },
  {
    key: 'roots',
    kind: 'roots',
    title: 'Configured roots',
    detail: 'All subdirectories up to 3 levels deep within configured roots.'
  },
  {
    key: 'drive',
    kind: 'drive',
    title: 'Full drives',
    detail:
      'Scans all local drives. The initial sweep may take several minutes; ' +
      'system paths such as Windows, Program Files, AppData, and node_modules are excluded.',
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
    // Reload catalog on open so newly dropped files appear without restarting.
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
          <span className="cm-usage__title">Settings</span>
          <span className="cm-usage__spacer" />
          <button className="cm-iconbtn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="cm-settings__body">
          <UpdateSection />

          <section className="cm-settings__section">
            <div className="cm-settings__row">
              <span className="cm-field__label">Theme</span>
              <button className="cm-chip" onClick={() => void window.cm.theme.openDir()}>
                Open themes folder
              </button>
            </div>

            <div className="cm-themes">
              {catalog.map((theme) => (
                <button
                  key={theme.id}
                  className={`cm-theme ${theme.id === config.themeId ? 'cm-theme--on' : ''}`}
                  onClick={() => patch({ themeId: theme.id })}
                  title={theme.source ?? 'built-in theme'}
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
                    {theme.custom && <span className="cm-theme__tag">custom</span>}
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
            <div className="cm-field__label">Starting directory</div>
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
              On restore, resume conversations in addition to directories
            </label>
            <label className="cm-settings__check">
              <input
                type="checkbox"
                checked={config.notifyOnWaiting}
                onChange={(e) => patch({ notifyOnWaiting: e.target.checked })}
              />
              Notify when a session awaits user input
            </label>
            <label className="cm-settings__check">
              <input
                type="checkbox"
                checked={config.notifyOnFinish}
                onChange={(e) => patch({ notifyOnFinish: e.target.checked })}
              />
              Notify when a session finishes its turn
            </label>
            <div className="cm-source__detail">
              Only when the window is unfocused. For input requests the taskbar icon
              flashes regardless.
            </div>
          </section>

          <KeymapEditor config={config} onPatch={patch} problems={keymapProblems} />

          <section className="cm-settings__section">
            <div className="cm-field__label">Roots to index</div>
            <textarea
              className="cm-settings__roots"
              value={rootsText}
              spellCheck={false}
              rows={4}
              placeholder={'One path per line\nC:\\Users\\...\\Projects'}
              onChange={(e) => setRootsText(e.target.value)}
              onBlur={commitRoots}
            />
          </section>

          <section className="cm-settings__section">
            <div className="cm-field__label">Folder picker sources</div>
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
                            {status.visited.toLocaleString('en-US')} folders visited ·{' '}
                            {status.found.toLocaleString('en-US')} found
                            {status.current ? ` · ${status.current}` : ''}
                          </span>
                          <button
                            className="cm-chip"
                            onClick={() => window.cm.index.cancel(source.kind as IndexKind)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="cm-source__progress">
                            {status?.scannedAt
                              ? `${status.found.toLocaleString('en-US')} folders · ${relative(status.scannedAt)}`
                              : 'never scanned'}
                          </span>
                          <button
                            className="cm-chip"
                            onClick={() => void window.cm.index.rescan(source.kind as IndexKind)}
                          >
                            {status?.scannedAt ? 'Rescan' : 'Scan'}
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
          Settings are saved in <code>%APPDATA%\claudemanager\config.json</code> and can be edited manually.
        </footer>
      </div>
    </div>
  )
}

/**
 * Running version and update status.
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
        <span className="cm-field__label">Version</span>
        <span className="cm-update__version">{version || '…'}</span>
        <span className="cm-usage__spacer" />
        {status !== 'unsupported' && (
          <button className="cm-chip" disabled={checking} onClick={() => void check()}>
            {checking || status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>

      <div className="cm-source__detail">
        {status === 'unsupported' && state?.message}
        {status === 'idle' &&
          (state?.checkedAt
            ? `No updates available · checked ${relative(state.checkedAt)}`
            : 'Update check runs shortly after startup and daily thereafter.')}
        {status === 'checking' && 'Checking for updates…'}
        {status === 'downloading' &&
          `Downloading version ${state?.version} · ${state?.percent ?? 0}%`}
        {status === 'error' && `Update check failed: ${state?.message}`}
        {status === 'available' && (
          <>
            Version <strong>{state?.version}</strong> is available. {state?.message}
          </>
        )}
        {status === 'ready' && (
          <>
            Version <strong>{state?.version}</strong> is ready. It will be installed automatically
            when the application exits.
          </>
        )}
      </div>

      {state?.notes && (status === 'available' || status === 'ready') && (
        <div className="cm-update__notes">{state.notes}</div>
      )}

      {status === 'available' && (
        <div className="cm-source__actions">
          <span className="cm-source__progress">
            Close ClaudeManager before replacing the executable.
          </span>
          <button className="cm-chip" onClick={() => void window.cm.update.openRelease()}>
            View version {state?.version}
          </button>
        </div>
      )}

      {status === 'ready' && (
        <div className="cm-source__actions">
          {confirming ? (
            <>
              <span className="cm-source__progress">
                Restarting will close all open sessions. Proceed?
              </span>
              <button className="cm-chip" onClick={() => setConfirming(false)}>
                No
              </button>
              <button className="cm-chip" onClick={() => void window.cm.update.install()}>
                Restart & install
              </button>
            </>
          ) : (
            <button className="cm-chip" onClick={() => setConfirming(true)}>
              Install now
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function relative(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
