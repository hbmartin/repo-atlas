import { useRef } from 'react'
import type { AtlasCluster, AtlasRepo } from '../types'
import type { AtlasPresentation } from '../presentation'
import { formatDate } from '../view-utils'
import { DetailSheet } from './DetailSheet'
import { FallbackLabel, FALLBACK_LABEL_EXPLANATION } from './FallbackLabel'

export function RegionPanel({ cluster, members, visible, presentation, onClose, onSelect, onClear, fallbackLabel }: {
  cluster?: AtlasCluster; members: AtlasRepo[]; visible: Set<string>; presentation: AtlasPresentation
  onClose: () => void; onSelect: (repo: AtlasRepo) => void; onClear: () => void; fallbackLabel: boolean
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const label = cluster?.label ?? 'Unclustered'
  const matching = members.filter(repo => visible.has(repo.full_name))
  const ordered = members.toSorted((a, b) => b.pushed_at.localeCompare(a.pushed_at) || a.full_name.localeCompare(b.full_name))
  const earliest = members.reduce((date, repo) => repo.created_at < date ? repo.created_at : date, members[0]?.created_at ?? '')
  const counts = new Map<string, number>()
  for (const repo of members) counts.set(repo.primary_language_category, (counts.get(repo.primary_language_category) ?? 0) + 1)
  const mix = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))

  return <DetailSheet label={`${label} region details`} onClose={onClose}>
    <span className="eyebrow">REGION</span>
    <h2 ref={heading} tabIndex={-1} className="region-title">{label}</h2>
    <p className="description">{cluster?.gloss ?? 'These repositories sit outside the named semantic regions.'}</p>
    {fallbackLabel && <p><FallbackLabel /> {FALLBACK_LABEL_EXPLANATION}</p>}
    <p className="region-count" aria-live="polite">{matching.length} matching / {members.length} repositories</p>
    {matching.length === 0 && <p className="notice">No repositories in this region match the current filters.{' '}
      <button onClick={() => { onClear(); heading.current?.focus({ preventScroll: true }) }}>Clear filters</button></p>}
    {earliest && ordered[0] && <p className="region-activity">
      Activity: {formatDate(earliest)} – {formatDate(ordered[0].pushed_at)}
    </p>}
    <section aria-label="Region language mix" className="region-language-mix">
      <h3>Primary languages</h3>
      <div className="language-bar" aria-hidden="true">{mix.map(([name, count]) =>
        <i key={name} style={{ flexGrow: count, background: presentation.languageColors.get(name) }} />)}</div>
      <ul>{mix.map(([name, count]) => <li key={name}>{name} <span>{count}</span></li>)}</ul>
    </section>
    <section className="neighbors" aria-label="Recent repositories">
      <h3>Recently pushed</h3>
      {ordered.slice(0, 3).map(repo => <button key={repo.full_name} onClick={() => onSelect(repo)}>
        <span><strong>{repo.name}</strong><small>{repo.one_liner}</small></span>
        <time dateTime={repo.pushed_at}>{formatDate(repo.pushed_at)}</time>
      </button>)}
    </section>
  </DetailSheet>
}
