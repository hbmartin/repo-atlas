import type { RefObject } from 'react'
import type { ViewState } from '../types'
import { formatDate } from '../view-utils'

export type ActiveFilterRemoval =
  | { kind: 'language'; value: string }
  | { kind: 'region'; value: string }
  | { kind: 'since' }

export function ActiveFilters({ view, onRemove, groupRef }: {
  view: ViewState
  onRemove: (filter: ActiveFilterRemoval) => void
  groupRef?: RefObject<HTMLDivElement | null>
}) {
  if (!view.languages.length && !view.regions.length && !view.since) return null
  return <div ref={groupRef} className="active-filters" role="group" aria-label="Active filters">
    {view.languages.map(name => <button key={`language-${name}`} type="button"
      aria-label={`Remove language filter ${name}`}
      onClick={() => onRemove({ kind: 'language', value: name })}>
      Language · {name}<span aria-hidden="true">×</span>
    </button>)}
    {view.regions.map(name => <button key={`region-${name}`} type="button"
      aria-label={`Remove region filter ${name}`}
      onClick={() => onRemove({ kind: 'region', value: name })}>
      Region · {name}<span aria-hidden="true">×</span>
    </button>)}
    {view.since && <button type="button" aria-label={`Remove updated since filter ${formatDate(view.since)}`}
      onClick={() => onRemove({ kind: 'since' })}>
      Since · {formatDate(view.since)}<span aria-hidden="true">×</span>
    </button>}
  </div>
}
