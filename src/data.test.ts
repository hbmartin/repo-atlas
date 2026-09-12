import { describe, expect, it } from 'vitest'
import { monthIndex, monthValue, searchRepos, unknownViewParameters, validateAtlas } from './data'
import type { AtlasData, AtlasRepo } from './types'

const repo = {
  name: 'graphviz2drawio', one_liner: 'Converts Graphviz diagrams', techniques: ['parsing'],
  what_it_does: 'Transforms DOT into editable diagrams.', domain: 'Developer tools', platform: 'CLI', topics: ['graphviz'],
} as AtlasRepo

describe('atlas data utilities', () => {
  it('rejects unknown schemas', () => expect(() => validateAtlas({ schema_version: 2 })).toThrow())
  it('weights and finds repository names', () => expect(searchRepos([repo], 'graphviz')[0]).toBe(repo))
  it('round trips month slider values', () => expect(monthValue(monthIndex('2024-06'))).toBe('2024-06'))
  it('reports unknown URL state without applying it', () => {
    const data = { repos: [{ ...repo, full_name: 'hbmartin/graphviz2drawio' }], languages: [{ name: 'Python' }], clusters: [{ label: 'Developer Tools' }] } as AtlasData
    expect(unknownViewParameters('?repo=missing/repo&lang=Rust&wat=1', data)).toEqual(['wat', 'repo=missing/repo', 'lang=Rust'])
  })
})
