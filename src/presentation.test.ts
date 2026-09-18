import { describe, expect, it, vi } from 'vitest'
import { atlasMonthRange, atlasPresentation, preserveValues, fileSizeScale, knownRegion, languageCategories, languageFilterNames, languageIndex, matchesLanguageFilter, normalizeLanguages, normalizeRegions, regionColors, regionFilterOptions, regionGuideOptions, sameValues } from './presentation'
import { readViewState, writeViewState } from './data'
import { makeAtlas, makeRepo } from './test-fixtures'

describe('atlas presentation', () => {
  it('keeps fixed categories and groups unfamiliar raw languages under Other', () => {
    const data = makeAtlas(['HTML', 'Java', 'Gleam'].map((primary_language, i) => makeRepo({ full_name: `owner/${i}`, primary_language })))
    expect(languageCategories(data)).toBe(data.languages)
    expect(data.languages).toHaveLength(10)
    expect(data.repos.every(repo => repo.primary_language_category === 'Other')).toBe(true)
    expect(atlasPresentation(data).languageColors.get('Other')).toBe('#DDDDDD')
    expect(normalizeLanguages(['HTML', 'Java', 'Other', 'Java'])).toEqual(['HTML', 'Java', 'Other'])
    expect(normalizeRegions(['Tools', 'Research', 'Tools'])).toEqual(['Tools', 'Research'])
  })
  it('accepts raw and category URL filters while reporting unavailable raw names', () => {
    const java = makeRepo({ primary_language: 'Java' })
    const cpp = makeRepo({ full_name: 'owner/cpp', primary_language: 'C++' })
    const data = makeAtlas([java, cpp])
    const parsed = readViewState('?lang=Java,Other,Java&layout=alt', data).view
    expect(parsed.languages).toEqual(['Java', 'Other'])
    expect(readViewState('?lang=Java,Other,Gleam', data).unknown).toEqual(['lang=Gleam'])
    expect(writeViewState(parsed)).toBe('?lang=Java&lang=Other&layout=alt')
    expect(writeViewState({ ...parsed, regions: ['Developer Tools', 'Developer Tools'] }))
      .toBe('?lang=Java&lang=Other&region=Developer+Tools&layout=alt')
    expect(readViewState('?lang=C%2B%2B', data).view.languages).toEqual(['C++'])
    expect(readViewState('?lang=Java&lang=Other,Gleam', data).view.languages).toEqual(['Java', 'Other'])
    expect(readViewState('?lang=Java&lang=Other,Gleam', data).unknown).toEqual(['lang=Gleam'])
    expect(writeViewState({ ...parsed, languages: ['C++'] })).toBe('?lang=C%2B%2B&layout=alt')
    expect(matchesLanguageFilter(data, java, 'Java')).toBe(true)
    expect(matchesLanguageFilter(data, cpp, 'Java')).toBe(false)
    expect(matchesLanguageFilter(data, cpp, 'Other')).toBe(true)
    expect(matchesLanguageFilter(data, cpp, 'Python')).toBe(false)
    expect(knownRegion(data, 'Developer Tools')).toBe(true)
    expect(knownRegion(data, 'Unclustered')).toBe(false)
    expect(readViewState('?region=Unclustered', data).view.regions).toEqual([])
    expect(readViewState('?region=Unclustered', data).unknown).toEqual(['region=Unclustered'])
    const withNoise = makeAtlas([makeRepo({ cluster_id: null })])
    expect(knownRegion(withNoise, 'Unclustered')).toBe(true)
    expect(readViewState('?region=Unclustered', withNoise).view.regions).toEqual(['Unclustered'])
    expect(knownRegion(data, 'Missing')).toBe(false)
  })
  it('round-trips repeated languages without reinterpreting comma-containing names', () => {
    const data = makeAtlas([
      makeRepo({ primary_language: 'Tea, Script' }),
      makeRepo({ full_name: 'owner/java', name: 'java', primary_language: 'Java' }),
    ])
    const state = { repo: null, languages: ['Tea, Script', 'Java'], regions: [], since: null, layoutAlt: false }
    const written = writeViewState(state)
    expect(written).toBe('?lang=Tea%2C+Script&lang=Java')
    expect(readViewState(written, data).view.languages).toEqual(['Tea, Script', 'Java'])
    expect(readViewState('?lang=Java,Other', data).view.languages).toEqual(['Java', 'Other'])
  })
  it('round-trips repeated regions without reinterpreting comma-separated labels', () => {
    const data = makeAtlas()
    data.clusters[0].label = 'Tools, Scripts'
    data.clusters.push({ ...data.clusters[0], id: 1, label: 'Research' })
    const state = { repo: null, languages: [], regions: ['Tools, Scripts', 'Research'], since: null, layoutAlt: false }
    const written = writeViewState(state)
    expect(written).toBe('?region=Tools%2C+Scripts&region=Research')
    expect(readViewState(written, data).view.regions).toEqual(['Tools, Scripts', 'Research'])
    expect(readViewState('?region=Tools%2C+Scripts', data).view.regions).toEqual(['Tools, Scripts'])

    const legacy = makeAtlas()
    legacy.clusters.push({ ...legacy.clusters[0], id: 1, label: 'Research' })
    const mixed = readViewState('?region=Developer+Tools,Research&region=Research&region=Missing', legacy)
    expect(mixed.view.regions).toEqual(['Research'])
    expect(mixed.unknown).toEqual(['region=Developer Tools,Research', 'region=Missing'])
  })
  it('applies the first scalar parameter and reports ignored repetitions once', () => {
    const data = makeAtlas([
      makeRepo({ pushed_at: '2024-01-15' }),
      makeRepo({ full_name: 'owner/newer', name: 'newer', pushed_at: '2025-06-01' }),
    ])
    const parsed = readViewState('?repo=owner%2Fexample&repo=missing%2Frepo&repo=missing%2Frepo&since=2025-06&since=&layout=alt&layout=bad', data)
    expect(parsed.view.repo).toBe('owner/example')
    expect(parsed.view.since).toBe('2025-06')
    expect(parsed.view.layoutAlt).toBe(true)
    expect(parsed.unknown).toEqual(['repo=missing/repo', 'layout=bad'])
  })
  it('ignores empty and identical scalar repetitions while warning about conflicting values once', () => {
    const data = makeAtlas([
      makeRepo({ pushed_at: '2024-01-15' }),
      makeRepo({ full_name: 'owner/newer', name: 'newer', pushed_at: '2025-06-01' }),
    ])
    const repeated = readViewState('?repo=&repo=owner%2Fexample&repo=owner%2Fexample&since=&since=2025-06&since=2025-06&layout=&layout=alt&layout=alt', data)
    expect(repeated.view).toMatchObject({ repo: 'owner/example', since: '2025-06', layoutAlt: true })
    expect(repeated.unknown).toEqual([])

    const conflicting = readViewState('?repo=owner%2Fexample&repo=owner%2Fnewer&repo=owner%2Fnewer&since=2025-06&since=2025-05&since=2025-05&layout=alt&layout=other&layout=other', data)
    expect(conflicting.view).toMatchObject({ repo: 'owner/example', since: '2025-06', layoutAlt: true })
    expect(conflicting.unknown).toEqual(['repo=owner/newer', 'since=2025-05', 'layout=other'])
  })
  it('bounds saved months and normalizes the earliest month to all dates', () => {
    const data = makeAtlas([
      makeRepo({ pushed_at: '2024-01-15' }),
      makeRepo({ full_name: 'owner/newer', pushed_at: '2025-06-01' }),
    ])
    expect(atlasMonthRange(data)).toEqual({ minMonth: 2024 * 12, maxMonth: 2025 * 12 + 5 })
    expect(readViewState('?since=2024-01', data).view.since).toBeNull()
    expect(readViewState('?since=2024-01', data).unknown).toEqual([])
    expect(readViewState('?since=2025-06', data).view.since).toBe('2025-06')
    expect(readViewState('?since=1990-01', data).view.since).toBeNull()
    expect(readViewState('?since=1990-01', data).unknown).toEqual([])
    expect(readViewState('?since=2999-01', data).unknown).toEqual(['since=2999-01'])
  })
  it('retains equivalent filter arrays', () => {
    const previous = ['Java', 'HTML']
    expect(sameValues(previous, ['Java', 'HTML'])).toBe(true)
    expect(sameValues(previous, ['HTML', 'Java'])).toBe(false)
    expect(sameValues(previous, ['Java'])).toBe(false)
    expect(preserveValues(previous, normalizeLanguages(['Java', 'HTML', 'Java']))).toBe(previous)
    expect(preserveValues(previous, ['HTML', 'Java'])).not.toBe(previous)
  })
  it('reuses language indices for the same immutable atlas and rebuilds for a new atlas', () => {
    const first = makeAtlas([makeRepo({ primary_language: 'Java' })])
    const index = languageIndex(first)
    expect(languageFilterNames(first)).toBe(index.names)
    expect(languageIndex(first)).toBe(index)
    const second = makeAtlas([makeRepo({ primary_language: 'HTML' })])
    expect(languageIndex(second)).not.toBe(index)
    expect(languageFilterNames(second)).toContain('HTML')
  })
  it('caps logarithmic radii and uses the same function for legend examples', () => {
    const scale = fileSizeScale([0, 10, 100, 1000, 10000].map(file_count => makeRepo({ file_count })))
    expect(scale.radius(null)).toBe(3.5)
    expect(scale.radius(0)).toBe(3.5)
    expect(scale.radius(1e9)).toBe(9)
    expect(scale.radius(100)).toBeGreaterThan(scale.radius(10))
    expect(scale.examples.every(value => scale.radius(value) >= 3.5 && scale.radius(value) <= 9)).toBe(true)
    expect(fileSizeScale([makeRepo(), makeRepo()]).radius(10)).toBe(3.5)
  })
  it('keeps region colors stable when the input order changes', () => {
    const data = makeAtlas()
    data.clusters.push({ ...data.clusters[0], id: 8 })
    expect(regionColors({ ...data, clusters: data.clusters.toReversed() })).toEqual(regionColors(data))
  })
  it('shares cluster and unclustered filter options', () => {
    const data = makeAtlas([makeRepo({ cluster_id: null })])
    expect(regionFilterOptions(data).map(({ label, count, cluster }) => ({ label, count, id: cluster?.id ?? null })))
      .toEqual([{ label: 'Developer Tools', count: 0, id: 0 }, { label: 'Unclustered', count: 1, id: null }])
    expect(knownRegion(data, 'Unclustered')).toBe(true)
  })
  it('defers sorting guide regions until the guide requests them', () => {
    const data = makeAtlas()
    data.clusters.push({ ...data.clusters[0], id: 1, label: 'Alpha' })
    const compare = vi.spyOn(String.prototype, 'localeCompare')

    regionFilterOptions(data)
    expect(compare).not.toHaveBeenCalled()

    regionGuideOptions(data)
    expect(compare).toHaveBeenCalled()
  })
  it('caches sorted guide regions and the unclustered entry per atlas', () => {
    const data = makeAtlas([makeRepo({ cluster_id: null })])
    data.clusters.push(
      { ...data.clusters[0], id: 1, label: 'Zulu' },
      { ...data.clusters[0], id: 2, label: 'Alpha' },
    )
    const guide = regionGuideOptions(data)
    expect(guide.clusteredRegions.map(region => region.label)).toEqual(['Alpha', 'Developer Tools', 'Zulu'])
    expect(guide.unclustered?.label).toBe('Unclustered')
    expect(regionGuideOptions(data)).toBe(guide)
    expect(regionGuideOptions(data).clusteredRegions).toBe(guide.clusteredRegions)
  })
})
