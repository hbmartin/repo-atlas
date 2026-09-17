import type { RefObject } from 'react'
import type { ViewState } from '../types'
import { formatDate } from '../view-utils'

export function ActiveFilters({ view, onRemove, groupRef }: {
  view: ViewState
  onRemove: (update: (current: ViewState) => ViewState, index: number) => void
  groupRef?: RefObject<HTMLDivElement | null>
}) {
  if (!view.languages.length && !view.regions.length && !view.since) return null
  return <div ref={groupRef} className="active-filters" role="group" aria-label="Active filters">
    {view.languages.map((name, index) => <button key={`language-${name}`} type="button"
      aria-label={`Remove language filter ${name}`}
      onClick={() => onRemove(current => ({ ...current, languages: current.languages.filter(value => value !== name) }), index)}>
      Language · {name}<span aria-hidden="true">×</span>
    </button>)}
    {view.regions.map((name, index) => <button key={`region-${name}`} type="button"
      aria-label={`Remove region filter ${name}`}
      onClick={() => onRemove(current => ({ ...current, regions: current.regions.filter(value => value !== name) }), view.languages.length + index)}>
      Region · {name}<span aria-hidden="true">×</span>
    </button>)}
    {view.since && <button type="button" aria-label={`Remove updated since filter ${formatDate(view.since)}`}
      onClick={() => onRemove(current => ({ ...current, since: null }), view.languages.length + view.regions.length)}>
      Since · {formatDate(view.since)}<span aria-hidden="true">×</span>
    </button>}
  </div>
}
