import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { searchRepos } from '../data'
import type { AtlasRepo } from '../types'

export function SearchBox({
  repos,
  onSelect,
}: {
  repos: AtlasRepo[]
  onSelect: (repo: AtlasRepo) => void
}) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const resultsId = useId()
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 120)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented) return
      const target = event.target
      if (target === input.current) return
      if (target instanceof HTMLElement && (
        target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )) return
      if (!input.current || input.current.closest('[inert]')) return
      event.preventDefault()
      input.current.focus()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
  const results = useMemo(() => searchRepos(repos, debounced), [repos, debounced])
  const activeIndex = Math.min(active, Math.max(0, results.length - 1))
  const choose = (repo: AtlasRepo) => {
    onSelect(repo)
    setQuery('')
    setDebounced('')
  }
  return (
    <div className="search-wrap">
      <label className="sr-only" htmlFor="repo-search">Search repositories</label>
      <span className="search-icon" aria-hidden="true">⌕</span>
      <input
        ref={input}
        id="repo-search"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={Boolean(debounced)}
        aria-controls={debounced ? resultsId : undefined}
        aria-activedescendant={results.length ? `${resultsId}-${activeIndex}` : undefined}
        value={query}
        placeholder="Search the atlas"
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={(event) => {
          if (!results.length) {
            if (event.key === 'Escape') {
              setQuery('')
              setDebounced('')
            }
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((activeIndex + 1) % results.length)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((activeIndex - 1 + results.length) % results.length)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            choose(results[activeIndex])
          } else if (event.key === 'Escape') {
            setQuery('')
            setDebounced('')
          }
        }}
      />
      <kbd>/</kbd>
      {debounced && (
        <div id={resultsId} className="search-results" role="listbox" aria-label="Repository results">
          {results.length ? results.map((repo, index) => (
            <button
              id={`${resultsId}-${index}`}
              key={repo.full_name}
              className={index === activeIndex ? 'active' : ''}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(repo)}
            >
              <span>{repo.name}</span>
              <small>{repo.one_liner}</small>
            </button>
          )) : <p role="status">No matches</p>}
        </div>
      )}
    </div>
  )
}
