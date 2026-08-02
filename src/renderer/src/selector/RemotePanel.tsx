import { useCallback, useEffect, useState } from 'react'
import type { RemoteDirListing, RemoteEntry, RemoteProbe, SshConnection } from '@shared/types'

/**
 * Parte remota del selettore: elenco delle connessioni salvate, modulo di
 * modifica ed esplorazione delle cartelle sul server.
 *
 * L'esplorazione remota costa un giro di rete per cartella, quindi non c'è
 * ricerca fuzzy: si naviga, e chi sa già dove andare scrive il percorso nel
 * campo in alto.
 */

interface RemotePanelProps {
  /** Connessione attiva; null quando si sta ancora scegliendo. */
  connection: SshConnection | null
  path: string
  cursor: number
  onCursor: (i: number) => void
  onSelect: (connection: SshConnection | null, path: string) => void
  onPathChange: (path: string) => void
  /**
   * Cartelle mostrate, oppure null quando il pannello non sta esplorando
   * (elenco dei server o modulo di modifica). Il selettore lo usa per sapere
   * se le frecce e l'Invio devono navigare o restare ai campi di testo.
   */
  onBrowsing: (entries: RemoteEntry[] | null) => void
  /** Doppio clic su una cartella remota: apre direttamente la sessione. */
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

  // Ogni cambio di cartella è una chiamata ssh: si annulla il risultato in
  // arrivo se nel frattempo si è navigato altrove, altrimenti una risposta
  // lenta sovrascriverebbe una più recente.
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
      // Il server risolve '~' e i percorsi relativi: si adotta la sua risposta,
      // così il percorso mostrato è quello vero.
      if (res.ok && res.path !== path) onPathChange(res.path)
    })
    return () => {
      cancelled = true
    }
  }, [connection, path, onPathChange, onCursor])

  // Le frecce del selettore agiscono sulle cartelle solo mentre si esplora.
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
            Nessun server salvato. Aggiungine uno per aprire Claude Code da remoto.
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
                modifica
              </button>
            </div>
          </div>
        ))}
        <button className="cm-remote__add" onClick={() => setEditing({ user: '', host: '' })}>
          ＋ Nuovo server
        </button>
      </div>
    )
  }

  return (
    <div className="cm-remote">
      <div className="cm-remote__bar">
        <button className="cm-chip" onClick={() => onSelect(null, '')}>
          ← server
        </button>
        <span className="cm-remote__where">
          {connection.user}@{connection.host}
        </span>
        {listing?.parent && (
          <button className="cm-chip" onClick={() => onPathChange(listing.parent as string)}>
            ↑ cartella superiore
          </button>
        )}
        <button className="cm-chip" onClick={() => setEditing(connection)}>
          impostazioni
        </button>
      </div>

      {!listing ? (
        <div className="cm-selector__empty">Lettura della cartella sul server…</div>
      ) : !listing.ok ? (
        <div className="cm-selector__empty">{listing.error}</div>
      ) : listing.entries.length === 0 ? (
        <div className="cm-selector__empty">
          Nessuna sottocartella. Invio apre una sessione qui.
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
 * Modulo di una connessione.
 *
 * Non c'è campo password di proposito: l'autenticazione la gestisce ssh con le
 * chiavi già configurate sul sistema. Salvare una password qui vorrebbe dire
 * scriverla in chiaro in un file JSON.
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
    // Un esito di prova riferito a parametri diversi da quelli a schermo
    // sarebbe peggio di nessun esito.
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
        <Field label="Nome" value={form.name ?? ''} onChange={(v) => set({ name: v })} placeholder="il mio server" />
        <Field label="Indirizzo" value={form.host ?? ''} onChange={(v) => set({ host: v })} placeholder="esempio.it" />
        <Field label="Utente" value={form.user ?? ''} onChange={(v) => set({ user: v })} placeholder="nome" />
        <Field
          label="Porta"
          value={form.port ? String(form.port) : ''}
          onChange={(v) => set({ port: v ? Number(v) : undefined })}
          placeholder="22"
        />
        <Field
          label="Cartella iniziale"
          value={form.remotePath ?? ''}
          onChange={(v) => set({ remotePath: v })}
          placeholder="~"
        />
        <Field
          label="Chiave privata"
          value={form.identityFile ?? ''}
          onChange={(v) => set({ identityFile: v })}
          placeholder="lascia vuoto per usare quelle predefinite"
        />
      </div>

      {result && (
        <div className={`cm-remote__probe ${result.ok ? '' : 'cm-remote__probe--bad'}`}>
          {result.ok ? (
            result.claudePath ? (
              <>
                Connessione riuscita · {result.os} · home {result.home} · Claude Code{' '}
                {result.claudeVersion}
              </>
            ) : (
              <>
                Connessione riuscita, ma Claude Code non risulta installato su questo server: le
                sessioni si apriranno sulla shell remota.
              </>
            )
          ) : (
            result.error
          )}
        </div>
      )}

      <div className="cm-remote__actions">
        <button className="cm-chip" onClick={onCancel}>
          Annulla
        </button>
        {form.id && (
          <button
            className="cm-chip cm-chip--danger"
            onClick={async () => {
              await window.cm.ssh.delete(form.id as string)
              onCancel()
            }}
          >
            Elimina
          </button>
        )}
        <span className="cm-remote__spacer" />
        <button className="cm-chip" disabled={!complete || testing} onClick={() => void test()}>
          {testing ? 'Prova in corso…' : 'Prova la connessione'}
        </button>
        <button className="cm-selector__go" disabled={!complete} onClick={() => void save()}>
          Salva
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
