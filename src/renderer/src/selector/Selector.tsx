import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ListDirResult } from '@shared/api'
import type {
  Effort,
  FolderCandidate,
  LaunchOptions,
  ModelAlias,
  PermissionMode,
  RemoteEntry,
  SshConnection
} from '@shared/types'
import { basename, shortenPath } from '../util/path'
import { RemotePanel } from './RemotePanel'

type Mode = 'search' | 'browse' | 'remote'

/**
 * Forma comune fra sessioni locali e remote: al selettore serve solo di che
 * cosa si tratta e quando è stata toccata l'ultima volta.
 */
interface PastSession {
  sessionId: string
  label: string
  modifiedAt: number
}

interface SelectorProps {
  defaults: {
    model: ModelAlias
    effort: Effort
    permissionMode: PermissionMode
  }
  startPath: string
  onCancel: () => void
  onOpen: (opts: LaunchOptions) => void
}

const MODELS: { value: ModelAlias; label: string }[] = [
  { value: 'default', label: 'predefinito' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' }
]

const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'default', label: 'predefinito' },
  { value: 'low', label: 'basso' },
  { value: 'medium', label: 'medio' },
  { value: 'high', label: 'alto' },
  { value: 'xhigh', label: 'molto alto' },
  { value: 'max', label: 'massimo' }
]

const PERMISSIONS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'normale' },
  { value: 'plan', label: 'piano' },
  { value: 'acceptEdits', label: 'accetta modifiche' },
  { value: 'auto', label: 'automatico' },
  { value: 'dontAsk', label: 'non chiedere' },
  { value: 'bypassPermissions', label: 'senza permessi' }
]

export function Selector({
  defaults,
  startPath,
  onCancel,
  onOpen
}: SelectorProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('search')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FolderCandidate[]>([])
  const [cursor, setCursor] = useState(0)
  const [favorites, setFavorites] = useState<string[]>([])

  const [dir, setDir] = useState<ListDirResult | null>(null)
  const [browsePath, setBrowsePath] = useState(startPath)
  const [browseCursor, setBrowseCursor] = useState(0)

  const [model, setModel] = useState<ModelAlias>(defaults.model)
  const [effort, setEffort] = useState<Effort>(defaults.effort)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(defaults.permissionMode)
  const [prompt, setPrompt] = useState('')

  const [remoteConn, setRemoteConn] = useState<SshConnection | null>(null)
  const [remotePath, setRemotePath] = useState('')
  const [remoteCursor, setRemoteCursor] = useState(0)
  /** null quando il pannello remoto non sta esplorando cartelle. */
  const [remoteEntries, setRemoteEntries] = useState<RemoteEntry[] | null>(null)

  const [pastSessions, setPastSessions] = useState<PastSession[]>([])
  /** null = nuova sessione; altrimenti l'id da riprendere. */
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [fork, setFork] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // La ricerca gira nel main: si attende un attimo per non interrogare
  // l'indice ad ogni singolo tasto.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void window.cm.folders.search(query).then((items) => {
        if (cancelled) return
        setResults(items)
        setCursor(0)
      })
    }, 90)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    void window.cm.folders.favorites().then(setFavorites)
  }, [])

  useEffect(() => {
    if (mode !== 'browse') return
    void window.cm.folders.list(browsePath).then((res) => {
      setDir(res)
      setBrowseCursor(0)
    })
  }, [mode, browsePath])

  useEffect(() => {
    inputRef.current?.focus()
  }, [mode])

  const selected = results[cursor] ?? null
  const browseEntries = dir?.entries ?? []

  const currentPath =
    mode === 'search' ? (selected?.path ?? '') : mode === 'browse' ? browsePath : remotePath

  /** In modo remoto serve una connessione scelta, non basta un percorso. */
  const canLaunch = mode === 'remote' ? Boolean(remoteConn && remotePath) : Boolean(currentPath)

  // Le sessioni pregresse della cartella evidenziata. Cambiando riga la
  // selezione di ripresa va azzerata: riprendere l'id di un'altra cartella
  // farebbe partire Claude nel posto sbagliato.
  //
  // Da remoto i transcript stanno sul server, quindi la lista costa una
  // chiamata ssh: è la stessa informazione, presa da un'altra parte.
  useEffect(() => {
    if (!currentPath || (mode === 'remote' && !remoteConn)) {
      setPastSessions([])
      setResumeId(null)
      return
    }
    let cancelled = false
    setResumeId(null)

    const query =
      mode === 'remote' && remoteConn
        ? window.cm.ssh
            .sessionsFor(remoteConn, currentPath)
            .then((res) => (res.ok ? res.sessions : []))
        : window.cm.claude.sessionsFor(currentPath)

    void query.then((list) => {
      if (!cancelled) setPastSessions(list)
    })
    return () => {
      cancelled = true
    }
  }, [currentPath, mode, remoteConn])

  const launch = useCallback(
    (path: string) => {
      if (!path) return
      if (mode === 'remote' && !remoteConn) return

      onOpen({
        // Da remoto la cartella locale è solo il punto da cui parte ssh; quella
        // di lavoro è remote.path.
        cwd: mode === 'remote' ? startPath : path,
        model,
        effort,
        permissionMode,
        initialPrompt: prompt.trim() || undefined,
        name: basename(path),
        resumeSessionId: resumeId ?? undefined,
        forkSession: resumeId ? fork : undefined,
        remote:
          mode === 'remote' && remoteConn
            ? {
                connectionId: remoteConn.id,
                name: remoteConn.name,
                host: remoteConn.host,
                user: remoteConn.user,
                port: remoteConn.port,
                identityFile: remoteConn.identityFile,
                path
              }
            : undefined
      })
    },
    [mode, remoteConn, startPath, model, effort, permissionMode, prompt, resumeId, fork, onOpen]
  )

  const toggleFav = useCallback((path: string) => {
    void window.cm.folders.toggleFavorite(path).then(setFavorites)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // L'overlay consuma tutto: il compositor e' gia' disattivato, ma senza
      // questo le frecce scorrerebbero anche la lista sottostante.
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const order: Mode[] = ['search', 'browse', 'remote']
        setMode((m) => order[(order.indexOf(m) + 1) % order.length])
        return
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        // I preferiti sono un indice di cartelle locali: una cartella remota
        // non ha un percorso che significhi qualcosa fuori dalla sua connessione.
        if (currentPath && mode !== 'remote') toggleFav(currentPath)
        return
      }

      if (mode === 'remote') {
        // Senza cartelle a schermo si sta scegliendo un server o compilando il
        // modulo: le frecce e l'Invio devono restare ai campi.
        if (!remoteEntries) return
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setRemoteCursor((c) => Math.min(c + 1, remoteEntries.length - 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setRemoteCursor((c) => Math.max(c - 1, 0))
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          const entry = remoteEntries[remoteCursor]
          if (entry) setRemotePath(entry.path)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const entry = remoteEntries[remoteCursor]
          if (e.ctrlKey && entry) setRemotePath(entry.path)
          else launch(remotePath)
        }
        return
      }

      if (mode === 'search') {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setCursor((c) => Math.min(c + 1, results.length - 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setCursor((c) => Math.max(c - 1, 0))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (e.ctrlKey && selected) {
            // Ctrl+Invio: entra nella cartella invece di aprirla.
            setBrowsePath(selected.path)
            setMode('browse')
          } else if (selected) {
            launch(selected.path)
          }
        }
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setBrowseCursor((c) => Math.min(c + 1, browseEntries.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setBrowseCursor((c) => Math.max(c - 1, 0))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const entry = browseEntries[browseCursor]
        if (entry) setBrowsePath(entry.path)
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault()
        if (dir?.parent) setBrowsePath(dir.parent)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        // Invio apre la cartella corrente; Ctrl+Invio entra in quella evidenziata.
        const entry = browseEntries[browseCursor]
        if (e.ctrlKey && entry) setBrowsePath(entry.path)
        else launch(browsePath)
      }
    },
    [
      mode,
      results.length,
      selected,
      browseEntries,
      browseCursor,
      dir,
      browsePath,
      currentPath,
      remoteEntries,
      remoteCursor,
      remotePath,
      launch,
      onCancel,
      toggleFav
    ]
  )

  // Tiene la riga evidenziata dentro l'area visibile.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor, browseCursor, mode])

  const favSet = useMemo(
    () => new Set(favorites.map((f) => f.replace(/[\\/]+$/, '').toLowerCase())),
    [favorites]
  )

  return (
    <div className="cm-overlay" onPointerDown={onCancel}>
      <div
        className="cm-selector"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cm-selector__head">
          <input
            ref={inputRef}
            className="cm-selector__input"
            placeholder={
              mode === 'search'
                ? 'Cerca una cartella, o incolla un percorso…'
                : mode === 'browse'
                  ? 'Frecce per navigare · Invio apre questa cartella'
                  : remoteConn
                    ? 'Percorso sul server · Invio apre questa cartella'
                    : 'Scegli un server salvato o aggiungine uno'
            }
            value={mode === 'search' ? query : mode === 'browse' ? browsePath : remotePath}
            onChange={(e) => {
              if (mode === 'search') setQuery(e.target.value)
              else if (mode === 'browse') setBrowsePath(e.target.value)
              else setRemotePath(e.target.value)
            }}
            disabled={mode === 'remote' && !remoteConn}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="cm-selector__modes">
            <button
              className={`cm-chip ${mode === 'search' ? 'cm-chip--on' : ''}`}
              onClick={() => setMode('search')}
            >
              Ricerca
            </button>
            <button
              className={`cm-chip ${mode === 'browse' ? 'cm-chip--on' : ''}`}
              onClick={() => setMode('browse')}
            >
              Esplora
            </button>
            <button
              className={`cm-chip ${mode === 'remote' ? 'cm-chip--on' : ''}`}
              onClick={() => setMode('remote')}
            >
              Remoto
            </button>
          </div>
        </div>

        <div className="cm-selector__list" ref={listRef}>
          {mode === 'search' ? (
            results.length === 0 ? (
              <div className="cm-selector__empty">Nessuna cartella corrisponde.</div>
            ) : (
              results.map((item, i) => (
                <Row
                  key={item.path}
                  candidate={item}
                  active={i === cursor}
                  favorite={favSet.has(item.path.replace(/[\\/]+$/, '').toLowerCase())}
                  onHover={() => setCursor(i)}
                  onOpen={() => launch(item.path)}
                  onToggleFavorite={() => toggleFav(item.path)}
                />
              ))
            )
          ) : mode === 'browse' ? (
            <BrowseList
              dir={dir}
              cursor={browseCursor}
              onHover={setBrowseCursor}
              onEnter={setBrowsePath}
            />
          ) : (
            <RemotePanel
              connection={remoteConn}
              path={remotePath}
              cursor={remoteCursor}
              onCursor={setRemoteCursor}
              onSelect={(conn, path) => {
                setRemoteConn(conn)
                setRemotePath(path)
              }}
              onPathChange={setRemotePath}
              onBrowsing={setRemoteEntries}
              onLaunch={() => launch(remotePath)}
            />
          )}
        </div>

        {pastSessions.length > 0 && (
          <div className="cm-resume">
            <div className="cm-resume__head">
              <span className="cm-field__label">
                {mode === 'remote' ? 'Sessioni sul server in ' : 'Sessioni precedenti in '}
                {basename(currentPath)}
              </span>
              {resumeId && (
                <label className="cm-resume__fork">
                  <input type="checkbox" checked={fork} onChange={(e) => setFork(e.target.checked)} />
                  crea una copia invece di continuare l&apos;originale
                </label>
              )}
            </div>
            <div className="cm-resume__list">
              <button
                className={`cm-resume__item ${resumeId === null ? 'cm-resume__item--on' : ''}`}
                onClick={() => setResumeId(null)}
              >
                <span className="cm-resume__label">＋ Nuova sessione</span>
              </button>
              {pastSessions.slice(0, 8).map((s) => (
                <button
                  key={s.sessionId}
                  className={`cm-resume__item ${resumeId === s.sessionId ? 'cm-resume__item--on' : ''}`}
                  onClick={() => setResumeId(s.sessionId)}
                  title={`${s.label}\n${s.sessionId}`}
                >
                  <span className="cm-resume__label">{s.label}</span>
                  <span className="cm-resume__when">{relativeTime(s.modifiedAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="cm-selector__options">
          <Select label="Modello" value={model} options={MODELS} onChange={setModel} />
          <Select label="Impegno" value={effort} options={EFFORTS} onChange={setEffort} />
          <Select
            label="Permessi"
            value={permissionMode}
            options={PERMISSIONS}
            onChange={setPermissionMode}
          />
          <input
            className="cm-selector__prompt"
            placeholder="Prompt iniziale (facoltativo)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
          />
          <button
            className="cm-selector__go"
            disabled={!canLaunch}
            onClick={() => launch(currentPath)}
          >
            {resumeId
              ? fork
                ? 'Duplica e apri'
                : 'Riprendi'
              : mode === 'remote'
                ? 'Apri sul server'
                : 'Apri sessione'}
          </button>
        </div>

        <div className="cm-selector__foot">
          <span className="cm-kbd">↑↓</span> scorri · <span className="cm-kbd">Invio</span> apri ·{' '}
          <span className="cm-kbd">Ctrl+Invio</span> entra · <span className="cm-kbd">Tab</span>{' '}
          cambia modo · <span className="cm-kbd">Ctrl+D</span> preferito ·{' '}
          <span className="cm-kbd">Esc</span> annulla
        </div>
      </div>
    </div>
  )
}

function Row({
  candidate,
  active,
  favorite,
  onHover,
  onOpen,
  onToggleFavorite
}: {
  candidate: FolderCandidate
  active: boolean
  favorite: boolean
  onHover: () => void
  onOpen: () => void
  onToggleFavorite: () => void
}): React.JSX.Element {
  const info = candidate.info
  return (
    <div
      className={`cm-row ${active ? 'cm-row--active' : ''}`}
      data-active={active}
      onPointerEnter={onHover}
      onClick={onOpen}
    >
      <button
        className={`cm-row__star ${favorite ? 'cm-row__star--on' : ''}`}
        title={favorite ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
      >
        {favorite ? '★' : '☆'}
      </button>

      <div className="cm-row__main">
        <div className="cm-row__name">
          <Highlighted text={basename(candidate.path)} />
        </div>
        <div className="cm-row__path">{shortenPath(candidate.path, 78)}</div>
      </div>

      <div className="cm-row__badges">
        {info?.exists === false && <span className="cm-badge cm-badge--warn">non esiste</span>}
        {info?.isGit && (
          <span className="cm-badge cm-badge--git" title="Repository git">
            ⑂ {info.branch ?? 'git'}
          </span>
        )}
        {info?.hasInstructions && (
          <span className="cm-badge" title="Contiene CLAUDE.md o AGENTS.md">
            CLAUDE.md
          </span>
        )}
        {(info?.sessionCount ?? 0) > 0 && (
          <span className="cm-badge cm-badge--accent" title="Sessioni Claude già presenti">
            {info?.sessionCount} sess.
          </span>
        )}
        {info?.exists && !info.trusted && (
          <span className="cm-badge cm-badge--warn" title="Claude Code chiederà di fidarsi">
            fiducia
          </span>
        )}
      </div>
    </div>
  )
}

/** L'evidenziazione dei caratteri trovati arriverà con l'indice esteso di M6. */
function Highlighted({ text }: { text: string }): React.JSX.Element {
  return <>{text}</>
}

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'ora'
  if (minutes < 60) return `${minutes} min fa`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h fa`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} g fa`
  return new Date(timestamp).toLocaleDateString('it-IT')
}

function BrowseList({
  dir,
  cursor,
  onHover,
  onEnter
}: {
  dir: ListDirResult | null
  cursor: number
  onHover: (i: number) => void
  onEnter: (path: string) => void
}): React.JSX.Element {
  if (!dir) return <div className="cm-selector__empty">Lettura in corso…</div>
  if (dir.error) return <div className="cm-selector__empty">Impossibile leggere: {dir.error}</div>
  if (dir.entries.length === 0)
    return <div className="cm-selector__empty">Nessuna sottocartella.</div>

  return (
    <>
      {dir.entries.map((entry, i) => (
        <div
          key={entry.path}
          className={`cm-row cm-row--compact ${i === cursor ? 'cm-row--active' : ''}`}
          data-active={i === cursor}
          onPointerEnter={() => onHover(i)}
          onDoubleClick={() => onEnter(entry.path)}
        >
          <span className="cm-row__folder">▸</span>
          <div className="cm-row__main">
            <div className="cm-row__name">{entry.name}</div>
          </div>
        </div>
      ))}
    </>
  )
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <label className="cm-field">
      <span className="cm-field__label">{label}</span>
      <select
        className="cm-field__select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
