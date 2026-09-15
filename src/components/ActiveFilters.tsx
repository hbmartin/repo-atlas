import type { ViewState } from '../types'
import { formatDate } from '../view-utils'

export function ActiveFilters({ view, setView }: {
  view: ViewState
  setView: (next: ViewState) => void
}) {
  if (!view.languages.length && !view.regions.length && !view.since) return null
  return <div className="active-filters" role="group" aria-label="Active filters">
    {view.languages.map(name => <button key={`language-${name}`} type="button"
      aria-label={`Remove language filter ${name}`}
      onClick={() => setView({ ...view, languages: view.languages.filter(value => value !== name) })}>
      Language · {name}<span aria-hidden="true">×</span>
    </button>)}
    {view.regions.map(name => <button key={`region-${name}`} type="button"
      aria-label={`Remove region filter ${name}`}
      onClick={() => setView({ ...view, regions: view.regions.filter(value => value !== name) })}>
      Region · {name}<span aria-hidden="true">×</span>
    </button>)}
    {view.since && <button type="button" aria-label={`Remove updated since filter ${formatDate(view.since)}`}
      onClick={() => setView({ ...view, since: null })}>
      Since · {formatDate(view.since)}<span aria-hidden="true">×</span>
    </button>}
  </div>
}
