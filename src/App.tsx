import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AtlasRequestError,
  loadAtlas,
  monthValue,
  normalizeAtlasSince,
  readViewState,
  validAtlasMonth,
  writeViewState,
} from './data'
import type { AtlasData, AtlasRepo, MapNavigationRequest, SelectionOptions, ViewState } from './types'
import { DetailPanel } from './components/DetailPanel'
import { ActiveFilters } from './components/ActiveFilters'
import { activeFilterEntries, activeFilterKey, type ActiveFilterRemoval } from './active-filters'
import { Filters } from './components/Filters'
import { ListView } from './components/ListView'
import { Loading } from './components/Loading'
import { MapView } from './components/MapView'
import { SearchBox } from './components/SearchBox'
import { COMPACT_MEDIA_QUERY, formatDate, setIncluded, useMediaQuery } from './view-utils'
import { AtlasGuide } from './components/AtlasGuide'
import { GuideDialog } from './components/GuideDialog'
import { atlasPresentation, knownLanguage, knownRegion, languageFilterNames, matchesLanguageFilter, normalizeLanguages, normalizeRegions, preserveValues, sameValues, type AtlasPresentation } from './presentation'
import './App.css'

const EMPTY_VIEW: ViewState = {
  repo: null,
  languages: [],
  regions: [],
  since: null,
  layoutAlt: false,
}

type FilterFocusRequest = { scope: 'controls' | 'dialog'; index: number | null }
type ViewUpdate = ViewState | ((current: ViewState) => ViewState)
type ViewUpdateOptions = SelectionOptions & { canonicalizeUrl?: boolean }
type ViewUpdateResult = { stateChanged: boolean; filtersChanged: boolean; view: ViewState }

const TOOL_VIEW_KEYS = new Set<keyof ViewState>(['repo', 'languages', 'regions', 'since', 'layoutAlt'])

function validateToolViewUpdate(input: unknown, data: AtlasData, presentation: AtlasPresentation): Partial<ViewState> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object.')
  const value = input as Record<string, unknown>
  const unknownKey = Object.keys(value).find(key => !TOOL_VIEW_KEYS.has(key as keyof ViewState))
  if (unknownKey !== undefined) throw new Error(`Unknown view property: ${unknownKey || '""'}.`)
  const update: Partial<ViewState> = {}

  if ('repo' in value) {
    if (value.repo !== null && (typeof value.repo !== 'string' || !value.repo.trim())) {
      throw new Error('repo must be an exact owner/name or null.')
    }
    if (typeof value.repo === 'string' && !presentation.reposByName.has(value.repo)) {
      throw new Error('Unknown repository.')
    }
    update.repo = value.repo as string | null
  }
  if ('languages' in value) {
    if (!Array.isArray(value.languages)) throw new Error('languages must be an array.')
    if (!value.languages.every(name => typeof name === 'string' && knownLanguage(data, name))) {
      throw new Error('Unknown language category or raw primary-language filter.')
    }
    update.languages = value.languages as string[]
  }
  if ('regions' in value) {
    if (!Array.isArray(value.regions)) throw new Error('regions must be an array.')
    if (!value.regions.every(name => typeof name === 'string' && knownRegion(data, name))) {
      throw new Error('Unknown region filter.')
    }
    update.regions = value.regions as string[]
  }
  if ('since' in value) {
    if (value.since !== null && (typeof value.since !== 'string' || !validAtlasMonth(value.since, data))) {
      throw new Error(`since must be null or a valid YYYY-MM month no later than ${monthValue(presentation.maxMonth)}.`)
    }
    update.since = typeof value.since === 'string' ? normalizeAtlasSince(value.since, data) : null
  }
  if ('layoutAlt' in value) {
    if (typeof value.layoutAlt !== 'boolean') throw new Error('layoutAlt must be a boolean.')
    update.layoutAlt = value.layoutAlt
  }
  return update
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

function focusElement(element: HTMLElement | null, reveal = false) {
  if (!element) return
  element.focus({ preventScroll: true })
  if (reveal) element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

export default function App() {
  const compact = useMediaQuery(COMPACT_MEDIA_QUERY)
  const [data, setData] = useState<AtlasData | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [view, setViewState] = useState<ViewState>(EMPTY_VIEW)
  const [listMode, setListMode] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [highlightRegion, setHighlightRegion] = useState<number | null>(null)
  const [navigationRequest, setNavigationRequest] = useState<MapNavigationRequest | null>(null)
  const [mobileFilters, setMobileFilters] = useState(false)
  if (mobileFilters && !compact) setMobileFilters(false)
  const [urlWarning, setUrlWarning] = useState<string[]>([])
  const navigationSequence = useRef(0)
  const navigationRequestRef = useRef<MapNavigationRequest | null>(null)
  const rollbackCandidateToken = useRef<number | null>(null)
  const replaceNavigation = useCallback((request: MapNavigationRequest | null) => {
    navigationRequestRef.current = request
    setNavigationRequest(request)
  }, [])
  const requestNavigation = useCallback((kind: 'repo' | 'region', target: string, clickToken?: number) => {
    replaceNavigation({ kind, target, clickToken, nonce: ++navigationSequence.current })
  }, [replaceNavigation])
  const acknowledgeNavigation = useCallback((nonce: number) => {
    if (navigationRequestRef.current?.nonce === nonce) replaceNavigation(null)
  }, [replaceNavigation])
  const viewRef = useRef(view)
  const searchInput = useRef<HTMLInputElement>(null)
  const filterButton = useRef<HTMLButtonElement>(null)
  const filterDialog = useRef<HTMLDivElement>(null)
  const doneButton = useRef<HTMLButtonElement>(null)
  const controlsChips = useRef<HTMLDivElement>(null)
  const dialogChips = useRef<HTMLDivElement>(null)
  const pendingFilterFocus = useRef<FilterFocusRequest | null>(null)
  const presentation = useMemo(() => data ? atlasPresentation(data) : null, [data])

  useEffect(() => {
    loadAtlas()
      .then((atlas) => {
        setData(atlas)
        const { view: initial, unknown } = readViewState(window.location.search, atlas)
        viewRef.current = initial
        setViewState(initial)
        if (initial.repo) requestNavigation('repo', initial.repo)
        setUrlWarning(unknown)
      })
      .catch((reason) => setError(reason instanceof Error ? reason : new Error(String(reason))))
  }, [requestNavigation])

  const setView = useCallback((update: ViewUpdate, options?: ViewUpdateOptions) => {
    const current = viewRef.current
    const rollbackToken = options?.navigate === false ? options.clickToken : undefined
    const pendingNavigation = navigationRequestRef.current
    if (rollbackToken !== undefined && rollbackCandidateToken.current !== rollbackToken) {
      return { stateChanged: false, filtersChanged: false, view: current } satisfies ViewUpdateResult
    }
    rollbackCandidateToken.current = rollbackToken !== undefined ? null : options?.clickToken ?? null
    const next = typeof update === 'function' ? update(current) : update
    const nextLanguages = normalizeLanguages(next.languages)
    const nextRegions = normalizeRegions(next.regions)
    const filtersChanged = next.since !== current.since
      || !sameValues(nextLanguages, current.languages) || !sameValues(nextRegions, current.regions)
    const normalized = {
      ...next,
      languages: preserveValues(current.languages, nextLanguages),
      regions: preserveValues(current.regions, nextRegions),
    }
    const stateChanged = filtersChanged || normalized.repo !== current.repo || normalized.layoutAlt !== current.layoutAlt
    const navigationTarget = options?.navigate !== false && normalized.repo
      && (normalized.repo !== current.repo || options?.navigate === true) ? normalized.repo : null
    if (navigationTarget) requestNavigation('repo', navigationTarget, options?.clickToken)
    else if (rollbackToken !== undefined) {
      if (pendingNavigation?.clickToken === rollbackToken) replaceNavigation(null)
    } else if (options?.navigate === false || (stateChanged && (!normalized.repo || filtersChanged))) {
      replaceNavigation(null)
    }
    if (stateChanged) {
      viewRef.current = normalized
      setViewState(normalized)
    }
    if (stateChanged || options?.canonicalizeUrl) {
      setUrlWarning([])
      window.history.replaceState(null, '', writeViewState(normalized))
    }
    return { stateChanged, filtersChanged, view: normalized } satisfies ViewUpdateResult
  }, [replaceNavigation, requestNavigation])

  useLayoutEffect(() => {
    const request = pendingFilterFocus.current
    if (!request) return
    pendingFilterFocus.current = null
    const group = (request.scope === 'dialog' ? dialogChips : controlsChips).current
    const chips = group ? [...group.querySelectorAll<HTMLButtonElement>('button')] : []
    const nextChip = request.index === null ? null : chips[Math.min(request.index, chips.length - 1)]
    const fallback = request.scope === 'dialog' && mobileFilters ? doneButton.current
      : compact ? filterButton.current : searchInput.current
    if (nextChip) {
      focusElement(nextChip, true)
    } else focusElement(fallback, request.scope === 'dialog' && mobileFilters)
  }, [view.languages, view.regions, view.since, mobileFilters, compact])

  useEffect(() => {
    if (!data) return
    const restore = () => {
      rollbackCandidateToken.current = null
      const { view: restored, unknown } = readViewState(window.location.search, data)
      viewRef.current = restored
      setViewState(restored)
      if (restored.repo) requestNavigation('repo', restored.repo)
      else replaceNavigation(null)
      setUrlWarning(unknown)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [data, replaceNavigation, requestNavigation])

  const closeMobileFilters = useCallback(() => {
    setMobileFilters(false)
    window.requestAnimationFrame(() => focusElement(filterButton.current, true))
  }, [])

  useEffect(() => {
    if (!mobileFilters || !filterDialog.current) return
    const dialog = filterDialog.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((element) => element.tagName === 'SUMMARY' || !element.closest('details:not([open])'))
    focusElement(doneButton.current, true)
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
        focusElement(last, true)
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        focusElement(first, true)
      }
    }
    dialog.addEventListener('keydown', handleKeyDown)
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [closeMobileFilters, mobileFilters])

  useEffect(() => {
    if (!data || !presentation || !document.modelContext?.registerTool) return
    const lifecycle = new AbortController()
    const earliestMonth = monthValue(presentation.minMonth)
    const latestMonth = monthValue(presentation.maxMonth)
    const registration = document.modelContext.registerTool({
      name: 'configure_atlas_view',
      title: 'Configure Repo Atlas view',
      description: 'Select a public repository and/or filter Repo Atlas by map language category or exact raw primary language, semantic region, date, or alternate layout. Language filters are combined with OR.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: ['string', 'null'], minLength: 1, description: 'Exact owner/name, or null to clear selection.' },
          languages: { type: 'array', description: 'Case-sensitive map categories or raw primary-language names currently in the atlas.', items: { type: 'string', enum: languageFilterNames(data) } },
          regions: { type: 'array', items: { type: 'string' } },
          since: {
            type: ['string', 'null'],
            pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
            description: `YYYY-MM no later than ${latestMonth}, or null. Months through ${earliestMonth} normalize to All dates.`,
          },
          layoutAlt: { type: 'boolean' },
        },
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) {
        const value = validateToolViewUpdate(input, data, presentation)
        const next = setView((current) => {
          const languages = value.languages ?? current.languages
          const regions = value.regions ?? current.regions
          const repo = value.repo === undefined ? current.repo : value.repo
          const since = value.since === undefined ? current.since : value.since
          return {
            repo,
            languages,
            regions,
            since,
            layoutAlt: value.layoutAlt ?? current.layoutAlt,
          }
        }).view
        return {
          selected_repo: next.repo,
          languages: [...next.languages],
          regions: [...next.regions],
          since: next.since,
          alternate_layout: next.layoutAlt,
        }
      },
    }, { signal: lifecycle.signal })
    Promise.resolve(registration).catch(() => undefined)
    return () => lifecycle.abort()
  }, [data, presentation, setView])
  const derived = useMemo(() => {
    if (!data || !presentation) return null
    const { clustersById } = presentation
    const visible = new Set(data.repos.filter((repo) => {
      const languageMatch = !view.languages.length || view.languages.some(name => matchesLanguageFilter(data, repo, name))
      const region = clustersById.get(repo.cluster_id ?? -1)?.label ?? 'Unclustered'
      const regionMatch = !view.regions.length || view.regions.includes(region)
      const dateMatch = !view.since || repo.pushed_at.slice(0, 7) >= view.since
      return languageMatch && regionMatch && dateMatch
    }).map((repo) => repo.full_name))
    const matchingRegions = new Set(data.repos.filter(repo => visible.has(repo.full_name)).flatMap(repo => repo.cluster_id == null ? [] : [repo.cluster_id])).size
    const matchingUnclustered = data.repos.filter(repo => visible.has(repo.full_name) && repo.cluster_id == null).length
    return { visible, matchingRegions, matchingUnclustered }
  }, [data, presentation, view.languages, view.regions, view.since])

  if (error) return (
    <main className="fatal">
      <span>{error instanceof AtlasRequestError ? 'DATA LINK LOST' : 'MALFORMED ATLAS'}</span>
      <h1>{error instanceof AtlasRequestError ? 'The atlas could not be loaded.' : 'The atlas data is not valid.'}</h1>
      <p>{error.message}</p>
      <a href="/atlas-list.html">Open the accessible repository list ↗</a>
    </main>
  )
  if (!data || !derived || !presentation) return <Loading />

  const { visible, matchingRegions, matchingUnclustered } = derived
  const { minMonth, maxMonth, reposByName } = presentation
  const selected = view.repo ? (reposByName.get(view.repo) ?? null) : null
  const filterCount = view.languages.length + view.regions.length + Number(Boolean(view.since))
  const clearFilters = (scope: FilterFocusRequest['scope']) => {
    pendingFilterFocus.current = { scope, index: null }
    if (!setView(current => ({ ...EMPTY_VIEW, repo: current.repo, layoutAlt: current.layoutAlt })).filtersChanged) pendingFilterFocus.current = null
  }
  const removeActiveFilter = (filter: ActiveFilterRemoval, scope: FilterFocusRequest['scope']) => {
    pendingFilterFocus.current = null
    const result = setView(current => {
      const index = activeFilterEntries(current).findIndex(entry => activeFilterKey(entry) === activeFilterKey(filter))
      if (index < 0) return current
      pendingFilterFocus.current = { scope, index }
      if (filter.kind === 'language') {
        return { ...current, languages: current.languages.filter(value => value !== filter.value) }
      }
      if (filter.kind === 'region') {
        return { ...current, regions: current.regions.filter(value => value !== filter.value) }
      }
      return { ...current, since: null }
    })
    if (!result.filtersChanged) pendingFilterFocus.current = null
  }
  const selectRepo = (repo: AtlasRepo | null, options?: SelectionOptions) => {
    setHighlightRegion(null)
    setView(current => ({ ...current, repo: repo?.full_name ?? null }), { ...options, navigate: options?.navigate ?? true })
  }
  const backgroundInert = mobileFilters || guideOpen ? true : undefined
  const profileUrl = `https://github.com/${encodeURIComponent(data.owner)}`

  const chooseRegion = (label: string, clickToken?: number) => {
    setView(current => ({ ...current, repo: null, regions: [label] }))
    requestNavigation('region', label, clickToken)
    setListMode(false)
    setGuideOpen(false)
    setHighlightRegion(null)
  }
  const guide = <AtlasGuide data={data} presentation={presentation} view={view}
    onLanguage={(name, included) => setView(current => ({ ...current, languages: setIncluded(current.languages, name, included) }))}
    onRegion={chooseRegion} onHighlight={setHighlightRegion} />

  return (
    <div className="app">
      {urlWarning.length > 0 && (
        <div className="url-warning" role="status">
          Some URL state was not recognized: {urlWarning.join(', ')}.{' '}
          <button onClick={() => {
            setView(EMPTY_VIEW, { navigate: false, canonicalizeUrl: true })
            window.requestAnimationFrame(() => {
              if (mobileFilters) focusElement(doneButton.current, true)
              else if (compact) focusElement(filterButton.current)
              else focusElement(searchInput.current)
            })
          }}>Reset link</button>
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
        <SearchBox repos={data.repos} onSelect={selectRepo} inputRef={searchInput} />
        <div className="desktop-filters">
          <Filters data={data} view={view} setView={setView} minMonth={minMonth} maxMonth={maxMonth} />
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
          <button className="clear-filters" onClick={() => clearFilters('controls')}>
            Clear filters
          </button>
        )}
        <ActiveFilters view={view} groupRef={controlsChips}
          onRemove={filter => removeActiveFilter(filter, 'controls')} />
      </section>
      {guideOpen && <GuideDialog onClose={() => { setGuideOpen(false); setHighlightRegion(null) }}>{guide}</GuideDialog>}
      {mobileFilters && (
        <div ref={filterDialog} className="mobile-filters" role="dialog" aria-modal="true" aria-labelledby="mobile-filter-title">
          <div>
            <header>
              <h2 id="mobile-filter-title">Filter the atlas</h2>
              <div className="header-actions">
                {filterCount > 0 && <button onClick={() => clearFilters('dialog')}>Clear all</button>}
                <button ref={doneButton} onClick={closeMobileFilters}>Done</button>
              </div>
            </header>
            <ActiveFilters view={view} groupRef={dialogChips}
              onRemove={filter => removeActiveFilter(filter, 'dialog')} />
            <Filters data={data} view={view} setView={setView} minMonth={minMonth} maxMonth={maxMonth} />
          </div>
        </div>
      )}
      <div className={`workspace ${selected ? 'has-selection' : ''}`} inert={backgroundInert}>
        {listMode ? (
          <ListView data={data} visible={visible} onSelect={(repo) => { selectRepo(repo); setListMode(false) }} />
        ) : (
          <MapView data={data} presentation={presentation} view={view} visible={visible} selected={selected} onSelect={selectRepo} navigationRequest={navigationRequest} onNavigationHandled={acknowledgeNavigation} highlightRegion={highlightRegion} onRegion={chooseRegion} />
        )}
        {visible.size === 0 && (
          <div className="no-results" role="status">No repositories match.{' '}<button onClick={() => clearFilters('controls')}>Clear filters</button></div>
        )}
        {selected ? <DetailPanel
          repo={selected}
          cluster={selected?.cluster_id == null ? undefined : data.clusters.find((cluster) => cluster.id === selected.cluster_id)}
          fallbackLabel={selected.cluster_id != null && (data.fallback_label_ids ?? []).includes(selected.cluster_id)}
          reposByName={reposByName}
          onSelect={selectRepo}
          onRegion={chooseRegion}
          onClose={() => selectRepo(null)}
        /> : <aside className="guide-panel">{guide}</aside>}
      </div>

    </div>
  )
}
