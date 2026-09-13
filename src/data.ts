import type { AtlasData, AtlasRepo, ViewState } from './types'

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`)
}

function requireFinite(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`)
}

function requireStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path} must be an array of strings`)
  }
}

function normalizeHttpUrl(value: unknown, path: string, nullable = false): string | null {
  if (nullable && (value === null || value === '')) return null
  requireString(value, path)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    try {
      parsed = new URL(`https://${value}`)
    } catch {
      if (nullable) return null
      throw new Error(`${path} must be a valid URL`)
    }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    if (nullable) return null
    throw new Error(`${path} must use HTTP or HTTPS`)
  }
  return parsed.toString()
}

export function validMonth(value: string): boolean {
  return MONTH.test(value)
}

export function validateAtlas(value: unknown): AtlasData {
  if (!isRecord(value)) throw new Error('Atlas data is not an object')
  const data = value as unknown as AtlasData
  if (data.schema_version !== 1) throw new Error('Unsupported atlas schema')
  requireString(data.generated_at, 'generated_at')
  requireString(data.owner, 'owner')
  if (data.embedding_model !== undefined) requireString(data.embedding_model, 'embedding_model')
  if (data.layout !== 'umap' && data.layout !== 'force') throw new Error('layout is invalid')
  if (data.layout_alt !== 'umap' && data.layout_alt !== 'force') throw new Error('layout_alt is invalid')
  if (!isRecord(data.bounds) || !Array.isArray(data.bounds.x) || !Array.isArray(data.bounds.y)) {
    throw new Error('bounds are malformed')
  }
  data.bounds.x.forEach((item, index) => requireFinite(item, `bounds.x[${index}]`))
  data.bounds.y.forEach((item, index) => requireFinite(item, `bounds.y[${index}]`))
  if (!isRecord(data.stats)) throw new Error('stats are missing')
  for (const key of ['repo_count', 'cluster_count', 'noise_count', 'low_confidence_count'] as const) {
    requireFinite(data.stats[key], `stats.${key}`)
  }
  if (!Array.isArray(data.repos) || !Array.isArray(data.clusters) || !Array.isArray(data.languages)) {
    throw new Error('Atlas collections are missing')
  }
  if (!data.repos.length) throw new Error('Atlas contains no repositories')
  const languageNames = new Set<string>()
  data.languages.forEach((language, index) => {
    requireString(language.name, `languages[${index}].name`)
    requireString(language.color, `languages[${index}].color`)
    requireFinite(language.count, `languages[${index}].count`)
    if (languageNames.has(language.name)) throw new Error(`Duplicate language ${language.name}`)
    languageNames.add(language.name)
  })
  const clusterIds = new Set<number>()
  const clusterLabels = new Set<string>()
  data.clusters.forEach((cluster, index) => {
    requireFinite(cluster.id, `clusters[${index}].id`)
    requireString(cluster.label, `clusters[${index}].label`)
    if (cluster.label.toLocaleLowerCase() === 'unclustered') {
      throw new Error('Cluster label Unclustered is reserved')
    }
    if (typeof cluster.gloss !== 'string') throw new Error(`clusters[${index}].gloss must be a string`)
    requireFinite(cluster.member_count, `clusters[${index}].member_count`)
    if (clusterIds.has(cluster.id)) throw new Error(`Duplicate cluster ${cluster.id}`)
    if (clusterLabels.has(cluster.label.toLocaleLowerCase())) throw new Error(`Duplicate cluster label ${cluster.label}`)
    clusterIds.add(cluster.id)
    clusterLabels.add(cluster.label.toLocaleLowerCase())
    for (const [name, anchor] of [['label_anchor', cluster.label_anchor], ['label_anchor_alt', cluster.label_anchor_alt]] as const) {
      if (name === 'label_anchor_alt' && anchor === undefined) continue
      if (!isRecord(anchor)) throw new Error(`clusters[${index}].${name} is malformed`)
      requireFinite(anchor.x, `clusters[${index}].${name}.x`)
      requireFinite(anchor.y, `clusters[${index}].${name}.y`)
    }
    for (const [name, contours] of [['contours', cluster.contours], ['contours_alt', cluster.contours_alt]] as const) {
      if (name === 'contours_alt' && contours === undefined) continue
      if (!isRecord(contours) || !Array.isArray(contours.outer) || !Array.isArray(contours.inner)) {
        throw new Error(`clusters[${index}].${name} is malformed`)
      }
    }
  })
  const repoNames = new Set<string>()
  data.repos.forEach((repo, index) => {
    const path = `repos[${index}]`
    for (const key of ['full_name', 'name', 'url', 'one_liner', 'what_it_does', 'domain', 'platform', 'artifact_type', 'maturity', 'primary_language'] as const) {
      requireString(repo[key], `${path}.${key}`)
    }
    repo.url = normalizeHttpUrl(repo.url, `${path}.url`)!
    repo.homepage = normalizeHttpUrl(repo.homepage, `${path}.homepage`, true)
    for (const key of ['x', 'y', 'x_alt', 'y_alt', 'stars', 'size_r'] as const) {
      requireFinite(repo[key], `${path}.${key}`)
    }
    if (repo.file_count !== null) requireFinite(repo.file_count, `${path}.file_count`)
    if (repo.cluster_id !== null && !clusterIds.has(repo.cluster_id)) throw new Error(`${path}.cluster_id is unknown`)
    if (!DAY.test(repo.created_at) || !DAY.test(repo.pushed_at)) throw new Error(`${path} has an invalid date`)
    requireStringArray(repo.techniques, `${path}.techniques`)
    requireStringArray(repo.topics, `${path}.topics`)
    if (!Array.isArray(repo.languages) || !Array.isArray(repo.neighbors)) throw new Error(`${path} collections are malformed`)
    repo.languages.forEach((language, languageIndex) => {
      requireString(language.name, `${path}.languages[${languageIndex}].name`)
      requireFinite(language.pct, `${path}.languages[${languageIndex}].pct`)
      if (language.color !== undefined) requireString(language.color, `${path}.languages[${languageIndex}].color`)
    })
    if (typeof repo.archived !== 'boolean' || typeof repo.is_fork !== 'boolean' || typeof repo.low_confidence !== 'boolean' || (repo.tree_truncated !== undefined && typeof repo.tree_truncated !== 'boolean')) {
      throw new Error(`${path} flags are malformed`)
    }
    if (repoNames.has(repo.full_name)) throw new Error(`Duplicate repository ${repo.full_name}`)
    if (repo.parent_full_name !== null && typeof repo.parent_full_name !== 'string') throw new Error(`${path}.parent_full_name is malformed`)
    repoNames.add(repo.full_name)
  })
  data.repos.forEach((repo, index) => repo.neighbors.forEach((neighbor, neighborIndex) => {
    requireString(neighbor.full_name, `repos[${index}].neighbors[${neighborIndex}].full_name`)
    requireFinite(neighbor.similarity, `repos[${index}].neighbors[${neighborIndex}].similarity`)
    if (!repoNames.has(neighbor.full_name)) throw new Error(`Repository neighbor ${neighbor.full_name} is unknown`)
  }))
  if (data.stats.repo_count !== data.repos.length || data.stats.cluster_count !== data.clusters.length) {
    throw new Error('Atlas stats do not match its collections')
  }
  return data
}

export class AtlasRequestError extends Error {}

export async function loadAtlas(): Promise<AtlasData> {
  let response: Response
  try {
    response = await fetch('/atlas.json')
  } catch (cause) {
    throw new AtlasRequestError('Atlas request failed because the network is unavailable.', { cause })
  }
  if (!response.ok) throw new AtlasRequestError(`Atlas request failed (${response.status})`)
  return validateAtlas(await response.json())
}

export function parseViewState(search: string, data: AtlasData): ViewState {
  const params = new URLSearchParams(search)
  const knownLanguages = new Set(data.languages.map((language) => language.name))
  const knownRegions = new Set([...data.clusters.map((cluster) => cluster.label), 'Unclustered'])
  const repo = params.get('repo')
  const since = params.get('since')
  return {
    repo: repo && data.repos.some((item) => item.full_name === repo) ? repo : null,
    languages: [...new Set((params.get('lang') ?? '').split(',').filter((value) => knownLanguages.has(value)))],
    regions: [...new Set((params.get('region') ?? '').split(',').filter((value) => knownRegions.has(value)))],
    since: since && validMonth(since) ? since : null,
    layoutAlt: params.get('layout') === 'alt',
  }
}

export function unknownViewParameters(search: string, data: AtlasData): string[] {
  const params = new URLSearchParams(search)
  const knownKeys = new Set(['repo', 'lang', 'region', 'since', 'layout'])
  const unknown = [...new Set([...params.keys()].filter((key) => !knownKeys.has(key)))]
  const repo = params.get('repo')
  if (repo && !data.repos.some((item) => item.full_name === repo)) unknown.push(`repo=${repo}`)
  const languages = new Set(data.languages.map((item) => item.name))
  for (const value of (params.get('lang') ?? '').split(',').filter(Boolean)) if (!languages.has(value)) unknown.push(`lang=${value}`)
  const regions = new Set([...data.clusters.map((item) => item.label), 'Unclustered'])
  for (const value of (params.get('region') ?? '').split(',').filter(Boolean)) if (!regions.has(value)) unknown.push(`region=${value}`)
  const since = params.get('since')
  if (since && !validMonth(since)) unknown.push(`since=${since}`)
  const layout = params.get('layout')
  if (layout && layout !== 'alt') unknown.push(`layout=${layout}`)
  return unknown
}

export function writeViewState(state: ViewState): string {
  const params = new URLSearchParams()
  if (state.repo) params.set('repo', state.repo)
  if (state.languages.length) params.set('lang', state.languages.join(','))
  if (state.regions.length) params.set('region', state.regions.join(','))
  if (state.since) params.set('since', state.since)
  if (state.layoutAlt) params.set('layout', 'alt')
  const value = params.toString()
  return value ? `?${value}` : window.location.pathname
}

export function searchableText(repo: AtlasRepo): string[] {
  return [
    repo.name, repo.one_liner, ...repo.techniques,
    repo.what_it_does, repo.domain, repo.platform, ...repo.topics,
  ].map((value) => value.toLocaleLowerCase())
}

export function searchRepos(repos: AtlasRepo[], query: string): AtlasRepo[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  return repos
    .map((repo) => {
      const fields = searchableText(repo)
      const weights = [10, 7, ...repo.techniques.map(() => 5), 3, 4, 4, ...repo.topics.map(() => 4)]
      const name = repo.name.toLocaleLowerCase()
      const fullName = repo.full_name.toLocaleLowerCase()
      const nameScore = fullName === needle ? 2000 : name === needle ? 1500 : name.startsWith(needle) ? 750 : 0
      const score = nameScore + fields.reduce((sum, value, index) => sum + (value.includes(needle) ? weights[index] ?? 1 : 0), 0)
      return { repo, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.repo.name.localeCompare(b.repo.name))
    .slice(0, 8)
    .map((entry) => entry.repo)
}

export function monthIndex(value: string): number {
  const [year, month] = value.slice(0, 7).split('-').map(Number)
  return year * 12 + month - 1
}

export function monthValue(index: number): string {
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`
}
