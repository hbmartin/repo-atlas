import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AtlasRequestError,
  loadAtlas,
  monthIndex,
  parseViewState,
  unknownViewParameters,
  validMonth,
  writeViewState,
} from './data'
import type { AtlasData, AtlasRepo, ViewState } from './types'
import { DetailPanel } from './components/DetailPanel'
import { Filters } from './components/Filters'
import { ListView } from './components/ListView'
import { Loading } from './components/Loading'
import { MapView } from './components/MapView'
import { SearchBox } from './components/SearchBox'
import { formatDate, toggleValue } from './view-utils'
import { AtlasGuide } from './components/AtlasGuide'
import { GuideDialog } from './components/GuideDialog'
import { displayLanguage, knownLanguage, normalizeLanguages, languageCategories } from './presentation'
import './App.css'

const EMPTY_VIEW: ViewState = {
  repo: null,
  languages: [],
  regions: [],
  since: null,
  layoutAlt: false,
}

const FOCUSABLE = [
  'a[href]',
  'summary',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export default function App() {
  const [data, setData] = useState<AtlasData | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [view, setViewState] = useState<ViewState>(EMPTY_VIEW)
  const [listMode, setListMode] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [highlightRegion, setHighlightRegion] = useState<number | null>(null)
  const [regionRequest, setRegionRequest] = useState<{ label: string; nonce: number } | null>(null)
  const [mobileFilters, setMobileFilters] = useState(false)
  const [urlWarning, setUrlWarning] = useState<string[]>([])
  const regionSequence = useRef(0)
  const viewRef = useRef(view)
  const filterButton = useRef<HTMLButtonElement>(null)
  const filterDialog = useRef<HTMLDivElement>(null)

  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => {
    loadAtlas()
      .then((atlas) => {
        setData(atlas)
        const warning = unknownViewParameters(window.location.search, atlas)
        const initial = parseViewState(window.location.search, atlas)
        viewRef.current = initial
        setViewState(initial)
        window.history.replaceState(null, '', writeViewState(initial))
        setUrlWarning(warning)
      })
      .catch((reason) => setError(reason instanceof Error ? reason : new Error(String(reason))))
  }, [])

  const setView = useCallback((next: ViewState) => {
    const normalized = { ...next, languages: normalizeLanguages(next.languages) }
    viewRef.current = normalized
    setViewState(normalized)
    window.history.replaceState(null, '', writeViewState(normalized))
  }, [])

  useEffect(() => {
    if (!data) return
    const restore = () => {
      const warning = unknownViewParameters(window.location.search, data)
      const restored = parseViewState(window.location.search, data)
      viewRef.current = restored
      setViewState(restored)
      setUrlWarning(warning)
      window.history.replaceState(null, '', writeViewState(restored))
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [data])

  const closeMobileFilters = useCallback(() => {
    setMobileFilters(false)
    window.requestAnimationFrame(() => filterButton.current?.focus())
  }, [])

  useEffect(() => {
    if (!mobileFilters || !filterDialog.current) return
    const dialog = filterDialog.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((element) => element.tagName === 'SUMMARY' || !element.closest('details:not([open])'))
    focusables()[0]?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMobileFilters()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', handleKeyDown)
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [closeMobileFilters, mobileFilters])

  useEffect(() => {
    if (!mobileFilters) return
    const query = window.matchMedia('(max-width: 1023px)')
    const closeAtDesktopWidth = () => {
      if (!query.matches) setMobileFilters(false)
    }
    closeAtDesktopWidth()
    query.addEventListener('change', closeAtDesktopWidth)
    return () => query.removeEventListener('change', closeAtDesktopWidth)
  }, [mobileFilters])

  useEffect(() => {
    if (!data || !document.modelContext?.registerTool) return
    const lifecycle = new AbortController()
    const registration = document.modelContext.registerTool({
      name: 'configure_atlas_view',
      title: 'Configure Repo Atlas view',
      description: 'Select a public repository and/or apply language, semantic-region, date, or alternate-layout filters to the visible Repo Atlas.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: ['string', 'null'], description: 'Exact owner/name, or null to clear selection.' },
          languages: { type: 'array', items: { type: 'string' } },
          regions: { type: 'array', items: { type: 'string' } },
          since: { type: ['string', 'null'], pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
          layoutAlt: { type: 'boolean' },
        },
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object.')
        const value = input as Partial<ViewState>
        const current = viewRef.current
        if (value.languages !== undefined && !Array.isArray(value.languages)) throw new Error('languages must be an array.')
        if (value.regions !== undefined && !Array.isArray(value.regions)) throw new Error('regions must be an array.')
        const languages = value.languages ?? current.languages
        const regions = value.regions ?? current.regions
        const repo = value.repo === undefined ? current.repo : value.repo
        const since = value.since === undefined ? current.since : value.since
        if (!languages.every((name) => knownLanguage(data, name))) throw new Error('Unknown language filter.')
        if (!regions.every((name) => name === 'Unclustered' || data.clusters.some((item) => item.label === name))) {
          throw new Error('Unknown region filter.')
        }
        if (repo && !data.repos.some((item) => item.full_name === repo)) throw new Error('Unknown repository.')
        if (since && !validMonth(since)) throw new Error('since must use a valid YYYY-MM month.')
        const next = {
          repo,
          languages: normalizeLanguages(languages),
          regions,
          since,
          layoutAlt: value.layoutAlt ?? current.layoutAlt,
        }
        setView(next)
        return {
          selected_repo: next.repo,
          languages: next.languages,
          regions: next.regions,
          since: next.since,
          alternate_layout: next.layoutAlt,
        }
      },
    }, { signal: lifecycle.signal })
    Promise.resolve(registration).catch(() => undefined)
    return () => lifecycle.abort()
  }, [data, setView])

  const derived = useMemo(() => {
    if (!data) return null
    const clusterNames = new Map(data.clusters.map((cluster) => [cluster.id, cluster.label]))
    let minMonth = Number.POSITIVE_INFINITY
    let maxMonth = Number.NEGATIVE_INFINITY
    const reposByName = new Map<string, AtlasRepo>()
    for (const repo of data.repos) {
      reposByName.set(repo.full_name, repo)
      const value = monthIndex(repo.pushed_at)
      minMonth = Math.min(minMonth, value)
      maxMonth = Math.max(maxMonth, value)
    }
    const visible = new Set(data.repos.filter((repo) => {
      const languageMatch = !view.languages.length || view.languages.includes(displayLanguage(repo.primary_language))
      const region = clusterNames.get(repo.cluster_id ?? -1) ?? 'Unclustered'
      const regionMatch = !view.regions.length || view.regions.includes(region)
      const dateMatch = !view.since || repo.pushed_at.slice(0, 7) >= view.since
      return languageMatch && regionMatch && dateMatch
    }).map((repo) => repo.full_name))
    const matchingRegions = new Set(data.repos.filter(repo => visible.has(repo.full_name)).flatMap(repo => repo.cluster_id == null ? [] : [repo.cluster_id])).size
    const matchingUnclustered = data.repos.filter(repo => visible.has(repo.full_name) && repo.cluster_id == null).length
    return { clusterNames, minMonth, maxMonth, reposByName, visible, matchingRegions, matchingUnclustered, filterData: { ...data, languages: languageCategories(data) } }
  }, [data, view.languages, view.regions, view.since])

  if (error) return (
    <main className="fatal">
      <span>{error instanceof AtlasRequestError ? 'DATA LINK LOST' : 'MALFORMED ATLAS'}</span>
      <h1>{error instanceof AtlasRequestError ? 'The atlas could not be loaded.' : 'The atlas data is not valid.'}</h1>
      <p>{error.message}</p>
      <a href="/atlas-list.html">Open the accessible repository list ↗</a>
    </main>
  )
  if (!data || !derived) return <Loading />

  const { minMonth, maxMonth, reposByName, visible, matchingRegions, matchingUnclustered, filterData } = derived
  const selected = view.repo ? (reposByName.get(view.repo) ?? null) : null
  const filterCount = view.languages.length + view.regions.length + Number(Boolean(view.since))
  const selectRepo = (repo: AtlasRepo | null) => {
    setRegionRequest(null)
    setView({ ...view, repo: repo?.full_name ?? null })
  }
  const backgroundInert = mobileFilters || guideOpen ? true : undefined
  const profileUrl = `https://github.com/${encodeURIComponent(data.owner)}`

  const chooseRegion = (label: string) => {
    setView({ ...view, repo: null, regions: [label] })
    setRegionRequest({ label, nonce: ++regionSequence.current })
    setListMode(false)
    setGuideOpen(false)
    setHighlightRegion(null)
  }
  const guide = <AtlasGuide data={data} view={view}
    onLanguage={name => setView({ ...view, languages: toggleValue(view.languages, name) })}
    onRegion={chooseRegion} onHighlight={setHighlightRegion} />

  return (
    <div className="app">
      {urlWarning.length > 0 && (
        <div className="url-warning" role="status">
          Some URL state was not recognized: {urlWarning.join(', ')}.{' '}
          <button onClick={() => { setUrlWarning([]); setView(EMPTY_VIEW) }}>Reset link</button>
        </div>
      )}
      <header className="topbar" inert={backgroundInert}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <h1>Repo Atlas</h1>
            <p aria-live="polite">{filterCount
              ? <>{visible.size} matching / {data.stats.repo_count} repositories · {matchingRegions} matching / {data.stats.cluster_count} regions{data.stats.noise_count > 0 && ` · ${matchingUnclustered} unclustered matches`}</>
              : <>{data.stats.repo_count} repositories · {data.stats.cluster_count} regions · rebuilt {formatDate(data.generated_at.slice(0, 10))}</>}</p>
          </div>
        </div>
        <a href={profileUrl} target="_blank" rel="noreferrer">{data.owner.toLocaleUpperCase()} / GITHUB ↗</a>
      </header>
      <section className="controls" inert={backgroundInert}>
        <SearchBox repos={data.repos} onSelect={selectRepo} />
        <div className="desktop-filters">
          <Filters data={filterData} view={view} setView={setView} minMonth={minMonth} maxMonth={maxMonth} />
        </div>
        <button ref={filterButton} className="mobile-filter-button" onClick={() => setMobileFilters(true)}>
          Filters{filterCount ? ` · ${filterCount}` : ''}
        </button>
        <div className="view-switch" role="group" aria-label="View mode">
          <button aria-pressed={!listMode} className={!listMode ? 'active' : ''} onClick={() => setListMode(false)}>Map</button>
          <button aria-pressed={listMode} className={listMode ? 'active' : ''} onClick={() => setListMode(true)}>List</button>
        </div>
        <button className="guide-trigger" onClick={() => setGuideOpen(true)}>Atlas guide</button>
        {filterCount > 0 && (
          <button className="clear-filters" onClick={() => setView({ ...EMPTY_VIEW, repo: view.repo, layoutAlt: view.layoutAlt })}>
            Clear filters
          </button>
        )}
      </section>
      {guideOpen && <GuideDialog onClose={() => { setGuideOpen(false); setHighlightRegion(null) }}>{guide}</GuideDialog>}
      {mobileFilters && (
        <div ref={filterDialog} className="mobile-filters" role="dialog" aria-modal="true" aria-labelledby="mobile-filter-title">
          <div>
            <header>
              <h2 id="mobile-filter-title">Filter the atlas</h2>
              <button onClick={closeMobileFilters}>Done</button>
            </header>
            <Filters data={filterData} view={view} setView={setView} minMonth={minMonth} maxMonth={maxMonth} />
          </div>
        </div>
      )}
      <div className={`workspace ${selected ? 'has-selection' : ''}`} inert={backgroundInert}>
        {listMode ? (
          <ListView data={data} visible={visible} onSelect={(repo) => { selectRepo(repo); setListMode(false) }} />
        ) : (
          <MapView data={data} view={view} visible={visible} selected={selected} onSelect={selectRepo} regionRequest={regionRequest} highlightRegion={highlightRegion} onHighlight={setHighlightRegion} onRegion={chooseRegion} />
        )}
        {visible.size === 0 && (
          <div className="no-results" role="status">No repositories match.{' '}<button onClick={() => setView({ ...EMPTY_VIEW, repo: null, layoutAlt: view.layoutAlt })}>Clear filters</button></div>
        )}
        {selected ? <DetailPanel
          repo={selected}
          cluster={selected?.cluster_id == null ? undefined : data.clusters.find((cluster) => cluster.id === selected.cluster_id)}
          reposByName={reposByName}
          onSelect={selectRepo}
          onRegion={chooseRegion}
          onClose={() => selectRepo(null)}
        /> : <aside className="guide-panel">{guide}</aside>}
      </div>

    </div>
  )
}
