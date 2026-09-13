import { describe, expect, it } from 'vitest'
import { displayLanguage, fileSizeScale, languageCategories, normalizeLanguages, regionColors } from './presentation'
import { parseViewState, unknownViewParameters, writeViewState } from './data'
import { makeAtlas, makeRepo } from './test-fixtures'

describe('atlas presentation', () => {
  it('aggregates retired languages while preserving Rust and Unknown', () => {
    const data = makeAtlas(['HTML', 'Java', 'Other', 'Rust', 'Unknown'].map((primary_language, i) => makeRepo({ full_name: `owner/${i}`, primary_language })))
    expect(languageCategories(data).map(({ name, count }) => [name, count])).toEqual([['Rust', 1], ['Other', 3], ['Unknown', 1]])
    expect(displayLanguage('Python')).toBe('Python')
    expect(normalizeLanguages(['HTML', 'Java', 'Other', 'Rust'])).toEqual(['Other', 'Rust'])
  })
  it('reads retired URL filters and writes their canonical category', () => {
    const data = makeAtlas([makeRepo({ primary_language: 'Java' })])
    data.languages = [{ name: 'Java', count: 1, color: '#000' }]
    const parsed = parseViewState('?lang=Java,Other&layout=alt', data)
    expect(parsed.languages).toEqual(['Other'])
    expect(unknownViewParameters('?lang=Java,Other', data)).toEqual([])
    expect(writeViewState(parsed)).toBe('?lang=Other&layout=alt')
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
