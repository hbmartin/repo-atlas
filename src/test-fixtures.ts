import type { AtlasData, AtlasRepo } from './types'

const CATEGORY_COLORS = {
  Python: '#77AADD', TypeScript: '#EE8866', Kotlin: '#EEDD88', JavaScript: '#FFAABB',
  Swift: '#99DDFF', Go: '#44BB99', Ruby: '#BBCC33', Rust: '#AAAA00',
  Other: '#DDDDDD', Unknown: '#87909E',
} as const
const NAMED_CATEGORIES = new Set<string>(Object.keys(CATEGORY_COLORS).filter(name => name !== 'Other' && name !== 'Unknown'))
const categoryForRaw = (name: string) => name === 'Unknown' ? 'Unknown' : NAMED_CATEGORIES.has(name) ? name : 'Other'

export function makeRepo(overrides: Partial<AtlasRepo> = {}): AtlasRepo {
  const primaryLanguage = overrides.primary_language ?? 'TypeScript'
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
    primary_language: primaryLanguage,
    primary_language_category: overrides.primary_language_category ?? categoryForRaw(primaryLanguage),
    languages: primaryLanguage === 'Unknown' ? [] : [{ name: primaryLanguage, pct: 100, color: NAMED_CATEGORIES.has(primaryLanguage) ? CATEGORY_COLORS[primaryLanguage as keyof typeof CATEGORY_COLORS] : '#DDDDDD' }],
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
    schema_version: 2,
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
    languages: Object.entries(CATEGORY_COLORS).map(([name, color]) => ({ name, count: repos.filter(repo => repo.primary_language_category === name).length, color })),
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
