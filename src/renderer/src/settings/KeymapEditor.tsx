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
 * Keybindings editor.
 *
 * Combinations are recorded by pressing keys directly.
 */

interface KeymapEditorProps {
  config: AppConfig
  onPatch: (patch: Partial<AppConfig>) => void
  /** Ignored combinations calculated by the resolver. */
  problems: KeymapProblem[]
}

/** Combinations reserved for terminal input. */
const RESERVED = new Set(['escape', 'enter', 'tab', 'backspace', 'space'])

export function KeymapEditor({ config, onPatch, problems }: KeymapEditorProps): React.JSX.Element {
  const [recording, setRecording] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { keymap } = useMemo(() => resolveKeymap(config.keymap), [config.keymap])

  /** Currently assigned combination for an action, if any. */
  const comboFor = useCallback(
    (action: Action): string | null =>
      Object.entries(keymap).find(([, a]) => a === action)?.[0] ?? null,
    [keymap]
  )

  const assign = useCallback(
    (action: Action, combo: string) => {
      const custom = { ...config.keymap }

      const owner = keymap[combo]
      if (owner && owner !== action) {
        const ownerCombo = comboFor(owner)
        if (ownerCombo) custom[ownerCombo] = ''
      }

      const previous = comboFor(action)
      if (previous && previous !== combo) custom[previous] = ''

      custom[combo] = action
      onPatch({ keymap: custom })
    },
    [config.keymap, keymap, comboFor, onPatch]
  )

  useEffect(() => {
    if (!recording) return

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return

      if (e.key === 'Escape') {
        setRecording(null)
        setError(null)
        return
      }

      const combo = signature(e)
      const bare = combo.split('+').pop() ?? ''

      if (!/^(ctrl|alt|shift|meta)\+/.test(combo)) {
        setError('At least one modifier required: otherwise key will not reach terminal.')
        return
      }
      if (RESERVED.has(bare) && !combo.includes('ctrl') && !combo.includes('alt')) {
        setError(`${prettyKey(combo)} is reserved for the terminal.`)
        return
      }

      assign(recording, combo)
      setRecording(null)
      setError(null)
    }

    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [recording, assign])

  const isCustomized = Object.keys(config.keymap).length > 0

  return (
    <section className="cm-settings__section">
      <div className="cm-settings__row">
        <span className="cm-field__label">Keybindings</span>
        <span className="cm-usage__spacer" />
        {isCustomized && (
          <button className="cm-chip" onClick={() => onPatch({ keymap: {} })}>
            Reset to defaults
          </button>
        )}
      </div>

      <div className="cm-source__detail">
        Click a row and press the desired combination. Requires at least one modifier key. <span className="cm-kbd">Esc</span> cancels.
      </div>

      {error && <div className="cm-keymap__error">{error}</div>}

      {problems.length > 0 && (
        <div className="cm-keymap__error">
          Ignored entries in config.json:{' '}
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
                {recording === action ? 'press…' : combo ? prettyKey(combo) : 'none'}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
