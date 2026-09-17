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
  setView: (update: (current: ViewState) => ViewState) => void
  minMonth: number
  maxMonth: number
}) {
  const sinceIndex = view.since ? monthIndex(view.since) : minMonth
  return (
    <div className="filter-content">
      <details className="filter-popover">
        <summary>Language{view.languages.length ? ` · ${view.languages.length}` : ''}</summary>
        <div className="filter-menu">
          {data.languages.filter(language => language.count > 0).map((language) => (
            <label key={language.name}>
              <input
                type="checkbox"
                checked={view.languages.includes(language.name)}
                onChange={() => setView(current => ({
                  ...current,
                  languages: toggleValue(current.languages, language.name),
                }))}
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
            ...(data.stats.noise_count > 0 ? [{ label: 'Unclustered', count: data.stats.noise_count }] : []),
          ].map((region) => (
            <label key={region.label}>
              <input
                type="checkbox"
                checked={view.regions.includes(region.label)}
                onChange={() => setView(current => ({
                  ...current,
                  regions: toggleValue(current.regions, region.label),
                }))}
              />
              <span>{region.label}</span>
              <small>{region.count}</small>
            </label>
          ))}
        </div>
      </details>
      <label className="date-filter">
        <span>Updated since <strong>{view.since ? formatDate(view.since) : 'All dates'}</strong></span>
        <input
          aria-label="Earliest repository update month"
          aria-valuetext={view.since ? formatDate(view.since) : 'All dates'}
          type="range"
          min={minMonth}
          max={maxMonth}
          value={sinceIndex}
          onChange={(event) => {
            const value = Number(event.target.value)
            setView(current => ({ ...current, since: value === minMonth ? null : monthValue(value) }))
          }}
        />
      </label>
      <details className="filter-popover map-options"><summary>Map options</summary><div className="filter-menu">
      <p>Switch the projection to explore another arrangement of the same repositories.</p>
      <button
        className={`layout-toggle ${view.layoutAlt ? 'active' : ''}`}
        aria-pressed={view.layoutAlt}
        onClick={() => setView(current => ({ ...current, layoutAlt: !current.layoutAlt }))}
      >
        Alternate layout
      </button>
      </div></details>
    </div>
  )
}
