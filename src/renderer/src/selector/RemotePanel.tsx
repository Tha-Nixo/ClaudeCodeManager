import { useCallback, useEffect, useState } from 'react'
import type { RemoteDirListing, RemoteEntry, RemoteProbe, SshConnection } from '@shared/types'

/**
 * Remote side of the picker: the list of saved connections, the edit form,
 * and browsing of the folders on the server.
 *
 * Remote browsing costs a network round trip per folder, so there is no fuzzy
 * search: you navigate, and whoever already knows where to go types the path
 * in the field at the top.
 */
interface RemotePanelProps {
  /** Active connection; null when selecting a server. */
  connection: SshConnection | null
  path: string
  cursor: number
  onCursor: (i: number) => void
  onSelect: (connection: SshConnection | null, path: string) => void
  onPathChange: (path: string) => void
  /**
   * Folders shown, or null when the panel is not browsing (server list or edit
   * form). The picker uses it to know whether the arrow keys and Enter should
   * navigate or stay with the text fields.
   */
  onBrowsing: (entries: RemoteEntry[] | null) => void
  /** Double click on a remote folder: opens the session directly. */
  onLaunch: () => void
}

export function RemotePanel({
  connection,
  path,
  cursor,
  onCursor,
  onSelect,
  onPathChange,
  onBrowsing,
  onLaunch
}: RemotePanelProps): React.JSX.Element {
  const [connections, setConnections] = useState<SshConnection[]>([])
  const [editing, setEditing] = useState<Partial<SshConnection> | null>(null)
  const [listing, setListing] = useState<RemoteDirListing | null>(null)

  const reload = useCallback(async () => {
    const list = await window.cm.ssh.list()
    setConnections(list)
    return list
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Every folder change is an ssh call: the incoming result is discarded if the
  // user has navigated elsewhere in the meantime, otherwise a slow answer would
  // overwrite a more recent one.
  useEffect(() => {
    if (!connection) {
      setListing(null)
      return
    }
    let cancelled = false
    setListing(null)
    void window.cm.ssh.listDir(connection, path || '~').then((res) => {
      if (cancelled) return
      setListing(res)
      onCursor(0)
      // The server resolves '~' and relative paths: its answer is adopted, so the
      // path shown is the real one.
      if (res.ok && res.path !== path) onPathChange(res.path)
    })
    return () => {
      cancelled = true
    }
  }, [connection, path, onPathChange, onCursor])

  // The picker's arrow keys act on the folders only while browsing.
  const browsing = Boolean(connection) && !editing
  useEffect(() => {
    onBrowsing(browsing && listing?.ok ? listing.entries : browsing ? [] : null)
  }, [browsing, listing, onBrowsing])

  if (editing) {
    return (
      <ConnectionForm
        draft={editing}
        onCancel={() => setEditing(null)}
        onSaved={async (saved) => {
          const list = await reload()
          setEditing(null)
          const fresh = list.find((c) => c.id === saved.id) ?? saved
          onSelect(fresh, fresh.remotePath)
        }}
      />
    )
  }

  if (!connection) {
    return (
      <div className="cm-remote">
        {connections.length === 0 && (
          <div className="cm-selector__empty">
            No saved servers. Add one to run Claude Code remotely.
          </div>
        )}
        {connections.map((c) => (
          <div
            key={c.id}
            className="cm-row"
            onClick={() => onSelect(c, c.remotePath)}
            onPointerEnter={() => onCursor(0)}
          >
            <span className="cm-row__folder">☁</span>
            <div className="cm-row__main">
              <div className="cm-row__name">{c.name}</div>
              <div className="cm-row__path">
                {c.user}@{c.host}
                {c.port && c.port !== 22 ? `:${c.port}` : ''} · {c.remotePath}
              </div>
            </div>
            <div className="cm-row__badges">
              <button
                className="cm-chip"
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing(c)
                }}
              >
                edit
              </button>
            </div>
          </div>
        ))}
        <button className="cm-remote__add" onClick={() => setEditing({ user: '', host: '' })}>
          ＋ New server
        </button>
      </div>
    )
  }

  return (
    <div className="cm-remote">
      <div className="cm-remote__bar">
        <button className="cm-chip" onClick={() => onSelect(null, '')}>
          ← servers
        </button>
        <span className="cm-remote__where">
          {connection.user}@{connection.host}
        </span>
        {listing?.parent && (
          <button className="cm-chip" onClick={() => onPathChange(listing.parent as string)}>
            ↑ parent directory
          </button>
        )}
        <button className="cm-chip" onClick={() => setEditing(connection)}>
          settings
        </button>
      </div>

      {!listing ? (
        <div className="cm-selector__empty">Reading directory on remote server…</div>
      ) : !listing.ok ? (
        <div className="cm-selector__empty">{listing.error}</div>
      ) : listing.entries.length === 0 ? (
        <div className="cm-selector__empty">
          No subdirectories. Press Enter to open a session here.
        </div>
      ) : (
        listing.entries.map((entry, i) => (
          <div
            key={entry.path}
            className={`cm-row cm-row--compact ${i === cursor ? 'cm-row--active' : ''}`}
            data-active={i === cursor}
            onPointerEnter={() => onCursor(i)}
            onClick={() => onPathChange(entry.path)}
            onDoubleClick={onLaunch}
          >
            <span className="cm-row__folder">▸</span>
            <div className="cm-row__main">
              <div className="cm-row__name">{entry.name}</div>
            </div>
            <div className="cm-row__badges">
              {entry.isGit && <span className="cm-badge cm-badge--git">⑂ git</span>}
              {entry.hasInstructions && <span className="cm-badge">CLAUDE.md</span>}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/**
 * Form for one connection.
 *
 * There is no password field, on purpose: ssh handles authentication with the
 * keys already configured on the system. Saving a password here would mean
 * writing it in plain text into a JSON file.
 */
function ConnectionForm({
  draft,
  onCancel,
  onSaved
}: {
  draft: Partial<SshConnection>
  onCancel: () => void
  onSaved: (saved: SshConnection) => void
}): React.JSX.Element {
  const [form, setForm] = useState<Partial<SshConnection>>(draft)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RemoteProbe | null>(null)

  const set = (patch: Partial<SshConnection>): void => {
    setForm((f) => ({ ...f, ...patch }))
    // A test result about parameters other than the ones on screen would be
    // worse than no result.
    setResult(null)
  }

  const complete = Boolean(form.host?.trim() && form.user?.trim())

  const test = async (): Promise<void> => {
    if (!complete) return
    setTesting(true)
    setResult(
      await window.cm.ssh.probe({
        host: form.host as string,
        user: form.user as string,
        port: form.port,
        identityFile: form.identityFile
      })
    )
    setTesting(false)
  }

  const save = async (): Promise<void> => {
    const saved = await window.cm.ssh.save(form)
    if (saved) onSaved(saved)
  }

  return (
    <div className="cm-remote cm-remote__form">
      <div className="cm-remote__grid">
        <Field label="Name" value={form.name ?? ''} onChange={(v) => set({ name: v })} placeholder="my-server" />
        <Field label="Host" value={form.host ?? ''} onChange={(v) => set({ host: v })} placeholder="example.com" />
        <Field label="User" value={form.user ?? ''} onChange={(v) => set({ user: v })} placeholder="username" />
        <Field
          label="Port"
          value={form.port ? String(form.port) : ''}
          onChange={(v) => set({ port: v ? Number(v) : undefined })}
          placeholder="22"
        />
        <Field
          label="Initial directory"
          value={form.remotePath ?? ''}
          onChange={(v) => set({ remotePath: v })}
          placeholder="~"
        />
        <Field
          label="Private key"
          value={form.identityFile ?? ''}
          onChange={(v) => set({ identityFile: v })}
          placeholder="leave empty to use default keys"
        />
      </div>

      {result && (
        <div className={`cm-remote__probe ${result.ok ? '' : 'cm-remote__probe--bad'}`}>
          {result.ok ? (
            result.claudePath ? (
              <>
                Connection successful · {result.os} · home {result.home} · Claude Code{' '}
                {result.claudeVersion}
              </>
            ) : (
              <>
                Connection successful, but Claude Code is not installed on this server:
                sessions will open a remote shell.
              </>
            )
          ) : (
            result.error
          )}
        </div>
      )}

      <div className="cm-remote__actions">
        <button className="cm-chip" onClick={onCancel}>
          Cancel
        </button>
        {form.id && (
          <button
            className="cm-chip cm-chip--danger"
            onClick={async () => {
              await window.cm.ssh.delete(form.id as string)
              onCancel()
            }}
          >
            Delete
          </button>
        )}
        <span className="cm-remote__spacer" />
        <button className="cm-chip" disabled={!complete || testing} onClick={() => void test()}>
          {testing ? 'Testing connection…' : 'Test connection'}
        </button>
        <button className="cm-selector__go" disabled={!complete} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <label className="cm-field">
      <span className="cm-field__label">{label}</span>
      <input
        className="cm-field__input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  )
}
