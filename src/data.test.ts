/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { monthIndex, monthValue, searchRepos, unknownViewParameters, validMonth, validateAtlas } from './data'
import type { AtlasData, AtlasRepo } from './types'
import { makeAtlas, makeRepo } from './test-fixtures'
import { formatDate } from './view-utils'

const repo = {
  full_name: 'hbmartin/graphviz2drawio', name: 'graphviz2drawio', one_liner: 'Converts Graphviz diagrams', techniques: ['parsing'],
  what_it_does: 'Transforms DOT into editable diagrams.', domain: 'Developer tools', platform: 'CLI', topics: ['graphviz'],
} as AtlasRepo

describe('atlas data utilities', () => {
  it('requires schema v2', () => {
    expect(validateAtlas(makeAtlas()).schema_version).toBe(2)
    expect(() => validateAtlas({ ...makeAtlas(), schema_version: 1 })).toThrow('Unsupported atlas schema')
    expect(() => validateAtlas({ schema_version: 3 })).toThrow('Unsupported atlas schema')
  })
  it('weights and finds repository names', () => expect(searchRepos([repo], 'graphviz')[0]).toBe(repo))
  it('round trips month slider values', () => expect(monthValue(monthIndex('2024-06'))).toBe('2024-06'))
  it('reports unknown URL state without applying it', () => {
    const data = { repos: [{ ...repo, full_name: 'hbmartin/graphviz2drawio' }], languages: [{ name: 'Python' }], clusters: [{ label: 'Developer Tools' }] } as AtlasData
    expect(unknownViewParameters('?repo=missing/repo&lang=Rust&wat=1', data)).toEqual(['wat', 'repo=missing/repo', 'lang=Rust'])
  })
  it('prioritizes an exact repository name over containing names', () => {
    const exact = makeRepo({ full_name: 'owner/graphviz2drawio', name: 'graphviz2drawio' })
    const formula = makeRepo({ full_name: 'owner/homebrew-graphviz2drawio', name: 'homebrew-graphviz2drawio' })
    expect(searchRepos([formula, exact], 'graphviz2drawio')[0]).toBe(exact)
  })
  it('rejects impossible month values', () => {
    expect(validMonth('2026-09')).toBe(true)
    expect(validMonth('2026-99')).toBe(false)
  })
  it('formats complete dates and month values in UTC', () => {
    expect(formatDate('2026-09')).toBe('Sep 2026')
    expect(formatDate('2026-09-01')).toBe('Sep 2026')
  })
  it('validates nested data and normalizes optional homepages', () => {
    const data = makeAtlas([makeRepo({ homepage: 'example.com' })])
    expect(validateAtlas(data).repos[0].homepage).toBe('https://example.com/')
    expect(validateAtlas(makeAtlas([makeRepo({ homepage: 'coming soon' })])).repos[0].homepage).toBeNull()
    expect(validateAtlas(makeAtlas([makeRepo({ homepage: 'javascript:alert(1)' })])).repos[0].homepage).toBeNull()
    expect(() => validateAtlas(makeAtlas([makeRepo({ pushed_at: 'invalid' })]))).toThrow('invalid date')
  })
  it('requires a category in the legend and matching category counts', () => {
    const data = makeAtlas([makeRepo({ primary_language: 'Java', primary_language_category: 'Other' })])
    data.languages = [{ name: 'Python', count: 1, color: '#77AADD' }]
    expect(() => validateAtlas(data)).toThrow('absent from the language legend')
    data.languages = [{ name: 'Other', count: 2, color: '#DDDDDD' }]
    expect(() => validateAtlas(data)).toThrow('Language category count is incorrect')
    data.languages[0].count = 1
    expect(validateAtlas(data).repos[0].primary_language).toBe('Java')
    expect(validateAtlas(data).repos[0].primary_language_category).toBe('Other')
  })
  it('requires category and detail colors in schema v2', () => {
    const missingCategory = makeAtlas() as unknown as { repos: Record<string, unknown>[] }
    delete missingCategory.repos[0].primary_language_category
    expect(() => validateAtlas(missingCategory)).toThrow('primary_language_category')
    const missingDetailColor = makeAtlas() as unknown as { repos: { languages: Record<string, unknown>[] }[] }
    delete missingDetailColor.repos[0].languages[0].color
    expect(() => validateAtlas(missingDetailColor)).toThrow('languages[0].color')
  })
  it('rejects duplicate region labels that would make filters ambiguous', () => {
    const data = makeAtlas()
    data.clusters.push({ ...data.clusters[0], id: 1 })
    data.stats.cluster_count = 2
    expect(() => validateAtlas(data)).toThrow('Duplicate cluster label')
  })
  it('reserves the Unclustered region name for noise repositories', () => {
    const data = makeAtlas()
    data.clusters[0].label = 'Unclustered'
    expect(() => validateAtlas(data)).toThrow('reserved')
  })
})

it('validates the committed deployable atlas snapshot', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../public/atlas.json', import.meta.url), 'utf8'))
  expect(validateAtlas(snapshot).stats.repo_count).toBe(snapshot.repos.length)
})

it('accepts optional fallback provenance in schema v2', () => {
  const data = makeAtlas()
  expect(validateAtlas(data).fallback_label_ids).toBeUndefined()
  data.fallback_label_ids = [0]
  expect(validateAtlas(data).fallback_label_ids).toEqual([0])
})

it.each([null, '0', [0, 0], [99], [0.5], ['0']])('rejects malformed fallback provenance: %j', value => {
  expect(() => validateAtlas({ ...makeAtlas(), fallback_label_ids: value })).toThrow('fallback_label_ids')
})
