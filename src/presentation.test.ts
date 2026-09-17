import { describe, expect, it } from 'vitest'
import { atlasPresentation, preserveValues, fileSizeScale, knownRegion, languageCategories, languageFilterNames, languageIndex, matchesLanguageFilter, normalizeLanguages, normalizeRegions, regionColors, sameValues } from './presentation'
import { parseViewState, unknownViewParameters, writeViewState } from './data'
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
    expect(writeViewState({ ...parsed, languages: ['C++'] })).toBe('?lang=C%2B%2B&layout=alt')
    expect(matchesLanguageFilter(data, java, 'Java')).toBe(true)
    expect(matchesLanguageFilter(data, cpp, 'Java')).toBe(false)
    expect(matchesLanguageFilter(data, cpp, 'Other')).toBe(true)
    expect(matchesLanguageFilter(data, cpp, 'Python')).toBe(false)
    expect(knownRegion(data, 'Developer Tools')).toBe(true)
    expect(knownRegion(data, 'Unclustered')).toBe(true)
    expect(knownRegion(data, 'Missing')).toBe(false)
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
})
