import { useCallback, useEffect, useRef, useState } from 'react'
import { clearSearch, focusPane, searchPane } from './registry'

/**
 * Search bar over the active pane's scrollback.
 *
 * It lives in the pane and not as an overlay: the search is about *that*
 * terminal, and a central panel would not say which one. On close, focus goes
 * back to the terminal, otherwise you would keep typing into an invisible field.
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

  // When the pane changes, the previous pane's highlights must go.
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

  // Search while typing, after a short wait: on a ten-thousand-line scrollback,
  // one search per keystroke can be felt.
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
      // The compositor is already disabled by the overlay, but without this, Alt
      // combinations would still reach the terminal underneath.
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
