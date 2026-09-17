import type { AtlasData, AtlasRepo } from './types'
import { monthIndex } from './month'

const uniqueValues = (names: string[]) => [...new Set(names)]
export const normalizeLanguages = uniqueValues
export const normalizeRegions = uniqueValues
export const sameValues = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])
export const languageCategories = (data: AtlasData) => data.languages
const languageIndices = new WeakMap<AtlasData, { names: string[]; nameSet: Set<string>; categorySet: Set<string> }>()
const regionIndices = new WeakMap<AtlasData, Set<string>>()
const monthRanges = new WeakMap<AtlasData, { minMonth: number; maxMonth: number }>()
export function languageIndex(data: AtlasData) {
  const cached = languageIndices.get(data)
  if (cached) return cached
  const categorySet = new Set(data.languages.map(item => item.name))
  const names = uniqueValues([
    ...categorySet,
    ...data.repos.map(repo => repo.primary_language).sort((a, b) => a.localeCompare(b)),
  ])
  const index = { names, nameSet: new Set(names), categorySet }
  languageIndices.set(data, index)
  return index
}
export const languageFilterNames = (data: AtlasData) => languageIndex(data).names
export const knownLanguage = (data: AtlasData, name: string) => languageIndex(data).nameSet.has(name)
export function knownRegion(data: AtlasData, name: string) {
  let names = regionIndices.get(data)
  if (!names) {
    names = new Set([
      ...data.clusters.map(cluster => cluster.label),
      ...(data.stats.noise_count > 0 ? ['Unclustered'] : []),
    ])
    regionIndices.set(data, names)
  }
  return names.has(name)
}
export const matchesLanguageFilter = (data: AtlasData, repo: AtlasRepo, name: string) =>
  languageIndex(data).categorySet.has(name)
    ? repo.primary_language_category === name
    : repo.primary_language === name

export function preserveValues(previous: string[], next: string[]) {
  return sameValues(previous, next) ? previous : next
}

export function atlasMonthRange(data: AtlasData) {
  const cached = monthRanges.get(data)
  if (cached) return cached
  let minMonth = Infinity, maxMonth = -Infinity
  for (const repo of data.repos) {
    const value = monthIndex(repo.pushed_at)
    minMonth = Math.min(minMonth, value)
    maxMonth = Math.max(maxMonth, value)
  }
  const range = { minMonth, maxMonth }
  monthRanges.set(data, range)
  return range
}

export function atlasPresentation(data: AtlasData) {
  const languages = data.languages
  const languageColors = new Map(languages.map(item => [item.name, item.color]))
  const reposByName = new Map(data.repos.map(repo => [repo.full_name, repo]))
  const clustersById = new Map(data.clusters.map(cluster => [cluster.id, cluster]))
  const { minMonth, maxMonth } = atlasMonthRange(data)
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
