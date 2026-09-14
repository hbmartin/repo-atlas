import { describe, expect, it } from 'vitest'
import { atlasPresentation, preserveValues, fileSizeScale, languageCategories, normalizeLanguages, normalizeRegions, regionColors } from './presentation'
import { parseViewState, unknownViewParameters, writeViewState } from './data'
import { makeAtlas, makeRepo } from './test-fixtures'

describe('atlas presentation', () => {
  it('preserves emitted categories, counts, order and colors including unfamiliar languages', () => {
    const data = makeAtlas(['HTML', 'Java', 'Other', 'Gleam'].map((primary_language, i) => makeRepo({ full_name: `owner/${i}`, primary_language })))
    data.languages[3].color = '#abcdef'
    expect(languageCategories(data)).toBe(data.languages)
    expect(atlasPresentation(data).languageColors.get('Gleam')).toBe('#abcdef')
    expect(normalizeLanguages(['HTML', 'Java', 'Other', 'Java'])).toEqual(['HTML', 'Java', 'Other'])
    expect(normalizeRegions(['Tools', 'Research', 'Tools'])).toEqual(['Tools', 'Research'])
  })
  it('preserves exact URL categories and reports missing ones', () => {
    const data = makeAtlas([makeRepo({ primary_language: 'Java' })])
    const parsed = parseViewState('?lang=Java,Other,Java&layout=alt', data)
    expect(parsed.languages).toEqual(['Java'])
    expect(unknownViewParameters('?lang=Java,Other', data)).toEqual(['lang=Other'])
    expect(writeViewState(parsed)).toBe('?lang=Java&layout=alt')
    expect(writeViewState({ ...parsed, regions: ['Developer Tools', 'Developer Tools'] }))
      .toBe('?lang=Java&region=Developer+Tools&layout=alt')
  })
  it('retains equivalent filter arrays', () => {
    const previous = ['Java', 'HTML']
    expect(preserveValues(previous, normalizeLanguages(['Java', 'HTML', 'Java']))).toBe(previous)
    expect(preserveValues(previous, ['HTML', 'Java'])).not.toBe(previous)
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
