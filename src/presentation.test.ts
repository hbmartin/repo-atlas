import { describe, expect, it } from 'vitest'
import { atlasMonthRange, atlasPresentation, preserveValues, fileSizeScale, knownRegion, languageCategories, languageFilterNames, languageIndex, matchesLanguageFilter, normalizeLanguages, normalizeRegions, regionColors, regionFilterOptions, sameValues } from './presentation'
import { parseViewState, readViewState, unknownViewParameters, writeViewState } from './data'
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
    const parsed = parseViewState('?lang=Java,Other,Java&layout=alt', data)
    expect(parsed.languages).toEqual(['Java', 'Other'])
    expect(unknownViewParameters('?lang=Java,Other,Gleam', data)).toEqual(['lang=Gleam'])
    expect(writeViewState(parsed)).toBe('?lang=Java%2COther&layout=alt')
    expect(writeViewState({ ...parsed, regions: ['Developer Tools', 'Developer Tools'] }))
      .toBe('?lang=Java%2COther&region=Developer+Tools&layout=alt')
    expect(parseViewState('?lang=C%2B%2B', data).languages).toEqual(['C++'])
    expect(parseViewState('?lang=Java&lang=Other,Gleam', data).languages).toEqual(['Java', 'Other'])
    expect(unknownViewParameters('?lang=Java&lang=Other,Gleam', data)).toEqual(['lang=Gleam'])
    expect(writeViewState({ ...parsed, languages: ['C++'] })).toBe('?lang=C%2B%2B&layout=alt')
    expect(matchesLanguageFilter(data, java, 'Java')).toBe(true)
    expect(matchesLanguageFilter(data, cpp, 'Java')).toBe(false)
    expect(matchesLanguageFilter(data, cpp, 'Other')).toBe(true)
    expect(matchesLanguageFilter(data, cpp, 'Python')).toBe(false)
    expect(knownRegion(data, 'Developer Tools')).toBe(true)
    expect(knownRegion(data, 'Unclustered')).toBe(false)
    expect(parseViewState('?region=Unclustered', data).regions).toEqual([])
    expect(unknownViewParameters('?region=Unclustered', data)).toEqual(['region=Unclustered'])
    const withNoise = makeAtlas([makeRepo({ cluster_id: null })])
    expect(knownRegion(withNoise, 'Unclustered')).toBe(true)
    expect(parseViewState('?region=Unclustered', withNoise).regions).toEqual(['Unclustered'])
    expect(knownRegion(data, 'Missing')).toBe(false)
  })
  it('round-trips repeated regions without reinterpreting comma-separated labels', () => {
    const data = makeAtlas()
    data.clusters[0].label = 'Tools, Scripts'
    data.clusters.push({ ...data.clusters[0], id: 1, label: 'Research' })
    const state = { repo: null, languages: [], regions: ['Tools, Scripts', 'Research'], since: null, layoutAlt: false }
    const written = writeViewState(state)
    expect(written).toBe('?region=Tools%2C+Scripts&region=Research')
    expect(parseViewState(written, data).regions).toEqual(['Tools, Scripts', 'Research'])
    expect(parseViewState('?region=Tools%2C+Scripts', data).regions).toEqual(['Tools, Scripts'])

    const legacy = makeAtlas()
    legacy.clusters.push({ ...legacy.clusters[0], id: 1, label: 'Research' })
    const mixed = readViewState('?region=Developer+Tools,Research&region=Research&region=Missing', legacy)
    expect(mixed.view.regions).toEqual(['Research'])
    expect(mixed.unknown).toEqual(['region=Developer Tools,Research', 'region=Missing'])
  })
  it('leaves repeated scalar parameters on their existing first-value behavior', () => {
    const data = makeAtlas()
    const parsed = readViewState('?repo=owner%2Fexample&repo=missing%2Frepo&layout=alt&layout=bad', data)
    expect(parsed.view.repo).toBe('owner/example')
    expect(parsed.view.layoutAlt).toBe(true)
    expect(parsed.unknown).toEqual([])
  })
  it('bounds saved months and normalizes the earliest month to all dates', () => {
    const data = makeAtlas([
      makeRepo({ pushed_at: '2024-01-15' }),
      makeRepo({ full_name: 'owner/newer', pushed_at: '2025-06-01' }),
    ])
    expect(atlasMonthRange(data)).toEqual({ minMonth: 2024 * 12, maxMonth: 2025 * 12 + 5 })
    expect(parseViewState('?since=2024-01', data).since).toBeNull()
    expect(unknownViewParameters('?since=2024-01', data)).toEqual([])
    expect(parseViewState('?since=2025-06', data).since).toBe('2025-06')
    expect(parseViewState('?since=1990-01', data).since).toBeNull()
    expect(unknownViewParameters('?since=1990-01', data)).toEqual([])
    expect(unknownViewParameters('?since=2999-01', data)).toEqual(['since=2999-01'])
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
})
