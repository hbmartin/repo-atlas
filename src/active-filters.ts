import type { ViewState } from './types'

export type ActiveFilterRemoval =
  | { kind: 'language'; value: string }
  | { kind: 'region'; value: string }
  | { kind: 'since'; value: string }

export function activeFilterRenderKey(filter: ActiveFilterRemoval) {
  return filter.kind === 'since' ? 'since' : `${filter.kind}:${filter.value}`
}

export function activeFilterEntries(view: ViewState): ActiveFilterRemoval[] {
  return [
    ...view.languages.map(value => ({ kind: 'language' as const, value })),
    ...view.regions.map(value => ({ kind: 'region' as const, value })),
    ...(view.since ? [{ kind: 'since' as const, value: view.since }] : []),
  ]
}
