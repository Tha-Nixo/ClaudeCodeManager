import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppConfig } from '@shared/types'
import {
  ACTION_LABELS,
  DEFAULT_KEYMAP,
  prettyKey,
  resolveKeymap,
  signature,
  type Action,
  type KeymapProblem
} from '../keys/bindings'

/**
 * Editor delle scorciatoie.
 *
 * Si registra premendo la combinazione, non scrivendola: la firma di un tasto
 * dipende da `code` e dall'ordine dei modificatori, e nessuno la indovina a
 * mano al primo colpo. La combinazione premuta viene mostrata così com'è
 * stata catturata, quindi quello che si vede è esattamente quello che l'app
 * confronterà.
 */

interface KeymapEditorProps {
  config: AppConfig
  onPatch: (patch: Partial<AppConfig>) => void
  /** Voci scartate dalla configurazione, già calcolate dall'app. */
  problems: KeymapProblem[]
}

/** Combinazioni che non vanno lasciate rubare al terminale. */
const RESERVED = new Set(['escape', 'enter', 'tab', 'backspace', 'space'])

export function KeymapEditor({ config, onPatch, problems }: KeymapEditorProps): React.JSX.Element {
  const [recording, setRecording] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { keymap } = useMemo(() => resolveKeymap(config.keymap), [config.keymap])

  /** Combinazione attualmente assegnata a un'azione, se ce n'è una. */
  const comboFor = useCallback(
    (action: Action): string | null =>
      Object.entries(keymap).find(([, a]) => a === action)?.[0] ?? null,
    [keymap]
  )

  const assign = useCallback(
    (action: Action, combo: string) => {
      const custom = { ...config.keymap }

      // La combinazione può essere già di qualcun altro: si libera, altrimenti
      // ne resterebbero due che rispondono e vincerebbe l'ordine di lettura.
      const owner = keymap[combo]
      if (owner && owner !== action) {
        const ownerCombo = comboFor(owner)
        if (ownerCombo) custom[ownerCombo] = ''
      }

      // La vecchia combinazione dell'azione va tolta esplicitamente: senza,
      // resterebbe quella predefinita e l'azione risponderebbe a due tasti.
      const previous = comboFor(action)
      if (previous && previous !== combo) custom[previous] = ''

      custom[combo] = action
      onPatch({ keymap: custom })
    },
    [config.keymap, keymap, comboFor, onPatch]
  )

  // La cattura è in fase di capture su window: deve vedere il tasto prima di
  // chiunque altro, compresi i campi di testo del pannello.
  useEffect(() => {
    if (!recording) return

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      // Un modificatore da solo non è una combinazione: si aspetta il tasto.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return

      if (e.key === 'Escape') {
        setRecording(null)
        setError(null)
        return
      }

      const combo = signature(e)
      const bare = combo.split('+').pop() ?? ''

      // Senza modificatori si ruberebbe un tasto normale al terminale, e
      // Claude smetterebbe di riceverlo.
      if (!/^(ctrl|alt|shift|meta)\+/.test(combo)) {
        setError('Serve almeno un modificatore: senza, il tasto non arriverebbe più al terminale.')
        return
      }
      if (RESERVED.has(bare) && !combo.includes('ctrl') && !combo.includes('alt')) {
        setError(`${prettyKey(combo)} è troppo importante per il terminale.`)
        return
      }

      assign(recording, combo)
      setRecording(null)
      setError(null)
    }

    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [recording, assign])

  const modificate = Object.keys(config.keymap).length > 0

  return (
    <section className="cm-settings__section">
      <div className="cm-settings__row">
        <span className="cm-field__label">Scorciatoie</span>
        <span className="cm-usage__spacer" />
        {modificate && (
          <button className="cm-chip" onClick={() => onPatch({ keymap: {} })}>
            Ripristina le predefinite
          </button>
        )}
      </div>

      <div className="cm-source__detail">
        Premi una riga e poi la combinazione che vuoi. Serve almeno un modificatore, altrimenti
        quel tasto smetterebbe di arrivare a Claude. <span className="cm-kbd">Esc</span> annulla.
      </div>

      {error && <div className="cm-keymap__error">{error}</div>}

      {problems.length > 0 && (
        <div className="cm-keymap__error">
          Voci ignorate in config.json:{' '}
          {problems.map((p) => `${p.combo} (${p.reason})`).join(' · ')}
        </div>
      )}

      <div className="cm-keymap">
        {ACTION_LABELS.map(({ action, label }) => {
          const combo = comboFor(action)
          const isDefault = combo !== null && DEFAULT_KEYMAP[combo] === action
          return (
            <button
              key={action}
              className={`cm-keymap__row ${recording === action ? 'cm-keymap__row--rec' : ''}`}
              onClick={() => {
                setError(null)
                setRecording(recording === action ? null : action)
              }}
            >
              <span className="cm-keymap__label">{label}</span>
              <span className={`cm-keymap__combo ${isDefault ? '' : 'cm-keymap__combo--custom'}`}>
                {recording === action ? 'premi…' : combo ? prettyKey(combo) : 'nessuna'}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
