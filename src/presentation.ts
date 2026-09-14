import type { AtlasData, AtlasRepo } from './types'

export const UNKNOWN_LANGUAGE_COLOR = '#87909e'
export const normalizeLanguages = (names: string[]) => [...new Set(names)]
export const languageCategories = (data: AtlasData) => data.languages
export const knownLanguage = (data: AtlasData, name: string) => data.languages.some(item => item.name === name)

export function preserveValues(previous: string[], next: string[]) {
  return previous.length === next.length && previous.every((value, i) => value === next[i]) ? previous : next
}

export function atlasPresentation(data: AtlasData) {
  const languages = data.languages
  const languageColors = new Map(languages.map(item => [item.name, item.color]))
  const reposByName = new Map(data.repos.map(repo => [repo.full_name, repo]))
  const clustersById = new Map(data.clusters.map(cluster => [cluster.id, cluster]))
  let minMonth = Infinity, maxMonth = -Infinity
  for (const repo of data.repos) {
    const [year, month] = repo.pushed_at.split('-').map(Number)
    const value = year * 12 + month - 1
    minMonth = Math.min(minMonth, value)
    maxMonth = Math.max(maxMonth, value)
  }
  return { languages, languageColors, reposByName, clustersById, minMonth, maxMonth,
    sizes: fileSizeScale(data.repos), colors: regionColors(data) }
}
export type AtlasPresentation = ReturnType<typeof atlasPresentation>

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0
  const index = (values.length - 1) * fraction
  const lower = Math.floor(index)
  return values[lower] + (values[Math.ceil(index)] - values[lower]) * (index - lower)
}
export function fileSizeScale(repos: AtlasRepo[]) {
  const counts = repos.flatMap((repo) => repo.file_count == null ? [] : [Math.max(0, repo.file_count)])
    .sort((a, b) => a - b)
  const low = percentile(counts, .05)
  const high = percentile(counts, .95)
  const radius = (count: number | null) => {
    if (count == null || high <= low) return 3.5
    const t = (Math.log1p(Math.max(0, count)) - Math.log1p(low)) / (Math.log1p(high) - Math.log1p(low))
    return 3.5 + 5.5 * Math.max(0, Math.min(1, t))
  }
  const examples = [...new Set([Math.round(low), Math.round(Math.sqrt((low + 1) * (high + 1)) - 1), Math.round(high)])]
  return { low, high, radius, examples }
}
const REGION_COLORS = ['#9EB8D6', '#C6AF93', '#8FBAB0', '#B1A4CB', '#B5BA94', '#C69FAE', '#91B7C4', '#C5AE84', '#9CACCC', '#ACAFA0']
export function regionColors(data: AtlasData) {
  return new Map(data.clusters.toSorted((a, b) => a.id - b.id)
    .map((cluster, index) => [cluster.id, REGION_COLORS[index % REGION_COLORS.length]]))
}
