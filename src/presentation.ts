import type { AtlasData, AtlasRepo } from './types'

export const LANGUAGE_COLORS: Record<string, string> = {
  Python: '#70C78C', TypeScript: '#64A8F5', Kotlin: '#B897F4', JavaScript: '#E8D76C',
  Swift: '#F49A63', Go: '#69D4D0', Ruby: '#E780B0', Rust: '#C6A27E',
  Other: '#A0A7B1', Unknown: '#D4DAE0',
}
export const displayLanguage = (name: string) => Object.hasOwn(LANGUAGE_COLORS, name) ? name : 'Other'
export const normalizeLanguages = (names: string[]) => [...new Set(names.map(displayLanguage))]
export function languageCategories(data: AtlasData) {
  const counts = new Map<string, number>()
  for (const repo of data.repos) {
    const name = displayLanguage(repo.primary_language)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return Object.entries(LANGUAGE_COLORS).filter(([name]) => counts.has(name))
    .map(([name, color]) => ({ name, color, count: counts.get(name)! }))
}
export function knownLanguage(data: AtlasData, name: string) {
  return data.languages.some((item) => item.name === name)
    || languageCategories(data).some((item) => item.name === name)
}

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
