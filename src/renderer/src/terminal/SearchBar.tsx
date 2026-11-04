import { useCallback, useEffect, useRef, useState } from 'react'
import { clearSearch, focusPane, searchPane } from './registry'

/**
 * Scrollback search bar for the active pane.
 */

interface SearchBarProps {
  paneId: string
  onClose: () => void
}

export function SearchBar({ paneId, onClose }: SearchBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<boolean | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => () => clearSearch(paneId), [paneId])

  const search = useCallback(
    (direction: 'next' | 'previous') => {
      if (!query) {
        setFound(null)
        return
      }
      setFound(searchPane(paneId, query, direction))
    },
    [paneId, query]
  )

  useEffect(() => {
    const t = setTimeout(() => search('next'), 160)
    return () => clearTimeout(t)
  }, [query, search])

  const close = useCallback(() => {
    clearSearch(paneId)
    onClose()
    focusPane(paneId)
  }, [paneId, onClose])

  return (
    <div
      className="cm-search"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          search(e.shiftKey ? 'previous' : 'next')
        }
      }}
    >
      <input
        ref={inputRef}
        className="cm-search__input"
        placeholder="Search terminal…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      {query && found === false && <span className="cm-search__none">no matches</span>}
      <button className="cm-search__btn" title="Previous (Shift+Enter)" onClick={() => search('previous')}>
        ↑
      </button>
      <button className="cm-search__btn" title="Next (Enter)" onClick={() => search('next')}>
        ↓
      </button>
      <button className="cm-search__btn" title="Close (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  )
}
