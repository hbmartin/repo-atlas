import type { RefObject } from 'react'
import type { ViewState } from '../types'
import { formatDate } from '../view-utils'
import { activeFilterEntries, activeFilterRenderKey, type ActiveFilterRemoval } from '../active-filters'

export function ActiveFilters({ view, onRemove, groupRef }: {
  view: ViewState
  onRemove: (filter: ActiveFilterRemoval) => void
  groupRef?: RefObject<HTMLDivElement | null>
}) {
  const filters = activeFilterEntries(view)
  if (!filters.length) return null
  return <div ref={groupRef} className="active-filters" role="group" aria-label="Active filters">
    {filters.map(filter => {
      if (filter.kind === 'since') return <button key={activeFilterRenderKey(filter)} type="button"
        aria-label={`Remove updated since filter ${formatDate(filter.value)}`}
        onClick={() => onRemove(filter)}>
        Since · {formatDate(filter.value)}<span aria-hidden="true">×</span>
      </button>
      const label = filter.kind === 'language' ? 'Language' : 'Region'
      return <button key={activeFilterRenderKey(filter)} type="button"
        aria-label={`Remove ${filter.kind} filter ${filter.value}`}
        onClick={() => onRemove(filter)}>
        {label} · {filter.value}<span aria-hidden="true">×</span>
      </button>
    })}
  </div>
}
