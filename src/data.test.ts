import { describe, expect, it } from 'vitest'
import { monthIndex, monthValue, readViewState, searchRepos, validMonth, validateAtlas } from './data'
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
    expect(readViewState('?repo=missing/repo&lang=Rust&wat=1', data).unknown).toEqual(['wat', 'repo=missing/repo', 'lang=Rust'])
  })
  it('prioritizes an exact repository name over containing names', () => {
    const exact = makeRepo({ full_name: 'owner/graphviz2drawio', name: 'graphviz2drawio' })
    const formula = makeRepo({ full_name: 'owner/homebrew-graphviz2drawio', name: 'homebrew-graphviz2drawio' })
    expect(searchRepos([formula, exact], 'graphviz2drawio')[0]).toBe(exact)
  })
  it('ranks every repository-name prefix ahead of exact language matches', () => {
    const primary = Array.from({ length: 9 }, (_, index) => makeRepo({
      full_name: `owner/language-${index}`, name: `language-${index}`, primary_language: 'Rust',
    }))
    const notes = makeRepo({ full_name: 'owner/rust-notes', name: 'rust-notes', primary_language: 'Unknown' })
    const web = makeRepo({ full_name: 'owner/rust-web', name: 'rust-web', primary_language: 'Unknown' })
    const results = searchRepos([...primary, web, notes], 'rust')
    expect(results).toHaveLength(8)
    expect(results.slice(0, 2)).toEqual([notes, web])
    expect(results.slice(2).every(repo => repo.primary_language === 'Rust')).toBe(true)
    expect(searchRepos([...primary, web, notes], 'rust-')).toEqual([notes, web])
  })
  it('ranks whole-name and token prefixes ahead of exact technology metadata', () => {
    const platform = makeRepo({ full_name: 'owner/terminal', name: 'terminal', platform: 'CLI' })
    const prefix = makeRepo({ full_name: 'owner/clicker', name: 'clicker', platform: 'Web' })
    const token = makeRepo({ full_name: 'owner/tool-cli', name: 'tool-cli', platform: 'Web' })
    expect(searchRepos([platform, token, prefix], 'cli')).toEqual([prefix, token, platform])
  })
  it('orders every match tier by repository-name relevance before semantic metadata', () => {
    const fullName = makeRepo({ full_name: 'python', name: 'full-name' })
    const exactName = makeRepo({ full_name: 'owner/exact-name', name: 'python' })
    const primary = makeRepo({ full_name: 'owner/primary', name: 'primary', primary_language: 'Python' })
    const composition = makeRepo({
      full_name: 'owner/composition', name: 'composition', primary_language: 'TypeScript',
      languages: [{ name: 'Python', pct: 20, color: '#3572A5' }],
    })
    const metadata = makeRepo({ full_name: 'owner/metadata', name: 'metadata', platform: 'Python' })
    const wholePrefix = makeRepo({ full_name: 'owner/python-tools', name: 'python-tools' })
    const tokenPrefix = makeRepo({ full_name: 'owner/tool-python', name: 'toolPythonKit' })
    const text = makeRepo({ full_name: 'owner/text', name: 'text', one_liner: 'Python examples' })
    expect(searchRepos([
      text, metadata, composition, primary, tokenPrefix, wholePrefix, exactName, fullName,
    ], 'python')).toEqual([
      fullName, exactName, wholePrefix, tokenPrefix, primary, composition, metadata, text,
    ])
  })
  it.each(['c', 'sdk'])('applies the eight-result cap after ranking %s name prefixes', (query) => {
    const prefixes = Array.from({ length: 9 }, (_, index) => makeRepo({
      full_name: `owner/${query}-prefix-${index}`, name: `${query}-prefix-${index}`, primary_language: 'Unknown',
    }))
    const exact = query === 'c'
      ? makeRepo({ full_name: 'owner/c-language', name: 'semantic-language', primary_language: 'C' })
      : makeRepo({ full_name: 'owner/sdk-platform', name: 'semantic-platform', platform: 'SDK' })
    const results = searchRepos([...prefixes, exact], query)
    expect(results).toHaveLength(8)
    expect(results).toEqual(prefixes.slice(0, 8))
    expect(results).not.toContain(exact)
  })
  it('matches whole-name prefixes containing separators', () => {
    const repos = [
      makeRepo({ full_name: 'owner/repo-atlas', name: 'repo-atlas' }),
      makeRepo({ full_name: 'owner/foo_bar', name: 'foo_bar' }),
      makeRepo({ full_name: 'owner/pkg.tools', name: 'pkg.tools' }),
    ]
    expect(searchRepos(repos, 'repo-at')).toEqual([repos[0]])
    expect(searchRepos(repos, 'foo_')).toEqual([repos[1]])
    expect(searchRepos(repos, 'pkg.')).toEqual([repos[2]])
  })
  it('matches name token prefixes without matching interior substrings', () => {
    const token = makeRepo({ full_name: 'owner/tool-GraphViz2Drawio', name: 'tool-GraphViz2Drawio' })
    const interior = makeRepo({ full_name: 'owner/mygraphviztool', name: 'mygraphviztool' })
    const results = searchRepos([interior, token], 'graphviz')
    expect(results).toEqual([token])
    expect(searchRepos([token], 'drawio')).toEqual([token])
  })
  it('ranks exact raw language names without treating Java as JavaScript', () => {
    const java = makeRepo({ full_name: 'owner/java-repo', name: 'jvm', primary_language: 'Java' })
    const javascript = makeRepo({ full_name: 'owner/javascript-repo', name: 'ecmascript', primary_language: 'JavaScript' })
    const cpp = makeRepo({ full_name: 'owner/cpp-repo', primary_language: 'C++' })
    const mixed = makeRepo({ full_name: 'owner/mixed', primary_language: 'TypeScript', languages: [{ name: 'C++', pct: 20, color: '#f34b7d' }] })
    const text = makeRepo({ full_name: 'owner/text', primary_language: 'Python', one_liner: 'Uses some Java examples.' })
    expect(searchRepos([text, javascript, java], 'Java').map(repo => repo.full_name)).toEqual(['owner/java-repo', 'owner/text'])
    expect(searchRepos([mixed, cpp], 'C++').map(repo => repo.full_name)).toEqual(['owner/cpp-repo', 'owner/mixed'])
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
  it('accepts a 191-repository reprojection but rejects malformed coordinates and counts', () => {
    const repos = Array.from({ length: 191 }, (_, index) => makeRepo({
      full_name: `owner/repo-${index}`, x: 100 + index, y_alt: 900 - index,
    }))
    const atlas = makeAtlas(repos)
    expect(validateAtlas(atlas).stats.repo_count).toBe(191)
    const wrongCount = makeAtlas(repos)
    wrongCount.stats.repo_count = 190
    expect(() => validateAtlas(wrongCount)).toThrow('Atlas stats do not match')
    const wrongCoordinates = makeAtlas(repos.map((repo, index) => index === 0 ? { ...repo, x_alt: 1001 } : repo))
    expect(() => validateAtlas(wrongCoordinates)).toThrow('outside atlas bounds')
    const wrongCategory = makeAtlas(repos)
    wrongCategory.languages[0].count = -1
    expect(() => validateAtlas(wrongCategory)).toThrow('Language category count is incorrect')
    const missingColor = makeAtlas(repos)
    missingColor.languages[0].color = ''
    expect(() => validateAtlas(missingColor)).toThrow('languages[0].color')
  })
  it('rejects zero-span bounds and stale counts derived from repositories', () => {
    const zeroX = makeAtlas()
    zeroX.bounds.x = [500, 500]
    expect(() => validateAtlas(zeroX)).toThrow('positive span')
    const zeroY = makeAtlas()
    zeroY.bounds.y = [500, 500]
    expect(() => validateAtlas(zeroY)).toThrow('positive span')

    const repos = [makeRepo({ cluster_id: null, low_confidence: true })]
    const staleNoise = makeAtlas(repos)
    staleNoise.stats.noise_count = 0
    expect(() => validateAtlas(staleNoise)).toThrow('stats.noise_count')
    const staleConfidence = makeAtlas(repos)
    staleConfidence.stats.low_confidence_count = 0
    expect(() => validateAtlas(staleConfidence)).toThrow('stats.low_confidence_count')
    const staleMembers = makeAtlas(repos)
    staleMembers.clusters[0].member_count = 1
    expect(() => validateAtlas(staleMembers)).toThrow('clusters[0].member_count')
    expect(validateAtlas(makeAtlas(repos)).stats.noise_count).toBe(1)
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

it('accepts optional fallback provenance in schema v2', () => {
  const data = makeAtlas()
  expect(validateAtlas(data).fallback_label_ids).toBeUndefined()
  data.fallback_label_ids = [0]
  expect(validateAtlas(data).fallback_label_ids).toEqual([0])
})

it.each([null, '0', [0, 0], [99], [0.5], ['0']])('rejects malformed fallback provenance: %j', value => {
  expect(() => validateAtlas({ ...makeAtlas(), fallback_label_ids: value })).toThrow('fallback_label_ids')
})
