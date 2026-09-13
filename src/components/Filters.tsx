import { monthIndex, monthValue } from '../data'
import type { AtlasData, ViewState } from '../types'
import { formatDate, toggleValue } from '../view-utils'

export function Filters({
  data,
  view,
  setView,
  minMonth,
  maxMonth,
}: {
  data: AtlasData
  view: ViewState
  setView: (next: ViewState) => void
  minMonth: number
  maxMonth: number
}) {
  const sinceIndex = view.since ? monthIndex(view.since) : minMonth
  return (
    <div className="filter-content">
      <details className="filter-popover">
        <summary>Language{view.languages.length ? ` · ${view.languages.length}` : ''}</summary>
        <div className="filter-menu">
          {data.languages.map((language) => (
            <label key={language.name}>
              <input
                type="checkbox"
                checked={view.languages.includes(language.name)}
                onChange={() => setView({
                  ...view,
                  languages: toggleValue(view.languages, language.name),
                })}
              />
              <i style={{ background: language.color }} />
              <span>{language.name}</span>
              <small>{language.count}</small>
            </label>
          ))}
        </div>
      </details>
      <details className="filter-popover">
        <summary>Region{view.regions.length ? ` · ${view.regions.length}` : ''}</summary>
        <div className="filter-menu regions">
          {[
            ...data.clusters.map((cluster) => ({ label: cluster.label, count: cluster.member_count })),
            { label: 'Unclustered', count: data.stats.noise_count },
          ].map((region) => (
            <label key={region.label}>
              <input
                type="checkbox"
                checked={view.regions.includes(region.label)}
                onChange={() => setView({
                  ...view,
                  regions: toggleValue(view.regions, region.label),
                })}
              />
              <span>{region.label}</span>
              <small>{region.count}</small>
            </label>
          ))}
        </div>
      </details>
      <label className="date-filter">
        <span>{view.since ? `Updated since ${formatDate(view.since)}` : 'All update dates'}</span>
        <input
          aria-label="Earliest repository update month"
          type="range"
          min={minMonth}
          max={maxMonth}
          value={sinceIndex}
          onChange={(event) => {
            const value = Number(event.target.value)
            setView({ ...view, since: value === minMonth ? null : monthValue(value) })
          }}
        />
      </label>
      <button
        className={`layout-toggle ${view.layoutAlt ? 'active' : ''}`}
        aria-pressed={view.layoutAlt}
        onClick={() => setView({ ...view, layoutAlt: !view.layoutAlt })}
      >
        Compare layout
      </button>
    </div>
  )
}
