import type { AtlasData, AtlasRepo, ViewState } from './types'

export function validateAtlas(value: unknown): AtlasData {
  if (!value || typeof value !== 'object') throw new Error('Atlas data is not an object')
  const data = value as Partial<AtlasData>
  if (data.schema_version !== 1) throw new Error('Unsupported atlas schema')
  if (!Array.isArray(data.repos) || !Array.isArray(data.clusters) || !Array.isArray(data.languages)) {
    throw new Error('Atlas collections are missing')
  }
  for (const repo of data.repos) {
    if (!repo.full_name || typeof repo.x !== 'number' || typeof repo.y !== 'number') {
      throw new Error('Atlas contains a malformed repository')
    }
  }
  return data as AtlasData
}

export async function loadAtlas(): Promise<AtlasData> {
  const response = await fetch('/atlas.json')
  if (!response.ok) throw new Error(`Atlas request failed (${response.status})`)
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
    languages: (params.get('lang') ?? '').split(',').filter((value) => knownLanguages.has(value)),
    regions: (params.get('region') ?? '').split(',').filter((value) => knownRegions.has(value)),
    since: since && /^\d{4}-\d{2}$/.test(since) ? since : null,
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
  if (since && !/^\d{4}-\d{2}$/.test(since)) unknown.push(`since=${since}`)
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
      const score = fields.reduce((sum, value, index) => sum + (value.includes(needle) ? weights[index] ?? 1 : 0), 0)
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
