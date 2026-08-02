import { useCallback, useEffect, useRef, useState } from 'react'
import { clearSearch, focusPane, searchPane } from './registry'

/**
 * Barra di ricerca nello scrollback del riquadro attivo.
 *
 * Vive nel riquadro e non come overlay: la ricerca riguarda *quel* terminale,
 * e un pannello centrale non direbbe quale. Alla chiusura il fuoco torna al
 * terminale, altrimenti si resterebbe a scrivere in un campo invisibile.
 */

interface SearchBarProps {
  paneId: string
  onClose: () => void
}

export function SearchBar({ paneId, onClose }: SearchBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [trovato, setTrovato] = useState<boolean | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  // Cambiando riquadro le evidenziazioni del precedente devono sparire.
  useEffect(() => () => clearSearch(paneId), [paneId])

  const cerca = useCallback(
    (direction: 'next' | 'previous') => {
      if (!query) {
        setTrovato(null)
        return
      }
      setTrovato(searchPane(paneId, query, direction))
    },
    [paneId, query]
  )

  // Ricerca mentre si scrive, con un attimo di attesa: su uno scrollback di
  // diecimila righe una ricerca per battuta si sente.
  useEffect(() => {
    const t = setTimeout(() => cerca('next'), 160)
    return () => clearTimeout(t)
  }, [query, cerca])

  const chiudi = useCallback(() => {
    clearSearch(paneId)
    onClose()
    focusPane(paneId)
  }, [paneId, onClose])

  return (
    <div
      className="cm-search"
      // Il compositor è già disattivato dall'overlay, ma senza questo le
      // combinazioni con Alt finirebbero comunque al terminale sottostante.
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          chiudi()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          cerca(e.shiftKey ? 'previous' : 'next')
        }
      }}
    >
      <input
        ref={inputRef}
        className="cm-search__input"
        placeholder="Cerca nel terminale…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      {query && trovato === false && <span className="cm-search__none">niente</span>}
      <button className="cm-search__btn" title="Precedente (Shift+Invio)" onClick={() => cerca('previous')}>
        ↑
      </button>
      <button className="cm-search__btn" title="Successivo (Invio)" onClick={() => cerca('next')}>
        ↓
      </button>
      <button className="cm-search__btn" title="Chiudi (Esc)" onClick={chiudi}>
        ✕
      </button>
    </div>
  )
}
