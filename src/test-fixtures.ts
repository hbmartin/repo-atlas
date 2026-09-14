import type { AtlasData, AtlasRepo } from './types'

export function makeRepo(overrides: Partial<AtlasRepo> = {}): AtlasRepo {
  return {
    full_name: 'owner/example',
    name: 'example',
    url: 'https://github.com/owner/example',
    homepage: null,
    x: 500,
    y: 500,
    x_alt: 510,
    y_alt: 510,
    cluster_id: 0,
    one_liner: 'An example repository.',
    what_it_does: 'Provides deterministic fixture data for frontend tests.',
    domain: 'Developer tools',
    platform: 'Web',
    techniques: ['testing'],
    artifact_type: 'application',
    maturity: 'working',
    primary_language: 'TypeScript',
    languages: [{ name: 'TypeScript', pct: 100, color: '#3178c6' }],
    topics: ['testing'],
    stars: 1,
    file_count: 10,
    size_r: 6,
    created_at: '2025-01-01',
    pushed_at: '2025-06-01',
    archived: false,
    is_fork: false,
    parent_full_name: null,
    low_confidence: false,
    tree_truncated: false,
    neighbors: [],
    ...overrides,
  }
}

export function makeAtlas(repos: AtlasRepo[] = [makeRepo()]): AtlasData {
  return {
    schema_version: 1,
    generated_at: '2026-09-12T00:00:00Z',
    owner: 'owner',
    embedding_model: 'test-model',
    layout: 'umap',
    layout_alt: 'force',
    bounds: { x: [0, 1000], y: [0, 1000] },
    stats: {
      repo_count: repos.length,
      cluster_count: 1,
      noise_count: 0,
      low_confidence_count: 0,
    },
    languages: [...new Set(repos.map(repo => repo.primary_language))].map(name => ({ name, count: repos.filter(repo => repo.primary_language === name).length, color: '#3178c6' })),
    clusters: [{
      id: 0,
      label: 'Developer Tools',
      gloss: 'Tools for developers.',
      member_count: repos.length,
      label_anchor: { x: 500, y: 500 },
      contours: { outer: [], inner: [] },
      label_anchor_alt: { x: 510, y: 510 },
      contours_alt: { outer: [], inner: [] },
    }],
    repos,
  }
}
