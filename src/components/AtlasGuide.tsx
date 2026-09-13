import { useMemo, useState } from 'react'
import type { AtlasData, ViewState } from '../types'
import { fileSizeScale, languageCategories, regionColors } from '../presentation'

export function AtlasGuide({ data, view, onLanguage, onRegion, onHighlight }: {
  data: AtlasData; view: ViewState; onLanguage: (name: string) => void
  onRegion: (name: string) => void; onHighlight: (id: number | null) => void
}) {
  const languages = useMemo(() => languageCategories(data), [data])
  const sizes = useMemo(() => fileSizeScale(data.repos), [data.repos])
  const colors = useMemo(() => regionColors(data), [data])
  const [expanded, setExpanded] = useState<number | null>(null)
  return <div className="atlas-guide">
    <header><span className="eyebrow">EXPLORE THE LANDSCAPE</span><h2>Atlas guide</h2>
      <p>One point, one repository. Nearby projects share ideas and techniques.</p></header>
    <p className="guide-instructions"><span className="desktop-hint">Hover to preview · Click to explore</span><span className="touch-hint">Tap a point to explore</span><br />Drag to pan · <span className="desktop-hint">Scroll to zoom</span><span className="touch-hint">Pinch to zoom</span> · <kbd>/</kbd> to search</p>
    <section aria-label="Language legend"><h3>Language <small>all repositories</small></h3>
      <div className="guide-languages">{languages.map(language => <button key={language.name}
        aria-label={`Filter by ${language.name}: ${language.count} repositories`} aria-pressed={view.languages.includes(language.name)} onClick={() => onLanguage(language.name)}>
        <i style={{ background: language.color }} /><span>{language.name}</span><small>{language.count}</small>
      </button>)}</div>
    </section>
    <section className="guide-size" aria-label="Repository size legend"><h3>Size <small>tracked files</small></h3>
      <div className="size-examples">{sizes.examples.map(count => <span key={count}><i style={{ width: sizes.radius(count) * 2, height: sizes.radius(count) * 2 }} /><small>{count.toLocaleString()}</small></span>)}</div>
      <p>Logarithmic scale; extremes capped. Missing counts use the smallest point.</p>
      <p className="confidence-key"><i />Sparse README / low-confidence summary</p>
    </section>
    <section className="guide-regions"><h3>Regions <small>select to focus</small></h3>
      {data.clusters.toSorted((a, b) => a.label.localeCompare(b.label)).map(cluster => <div key={cluster.id}>
        <button aria-pressed={view.regions.includes(cluster.label)} onClick={() => onRegion(cluster.label)}
          onPointerEnter={() => { onHighlight(cluster.id); setExpanded(cluster.id) }}
          onPointerLeave={() => { onHighlight(null); setExpanded(null) }}
          onFocus={() => { onHighlight(cluster.id); setExpanded(cluster.id) }}
          onBlur={() => { onHighlight(null); setExpanded(null) }}>
          <i style={{ background: colors.get(cluster.id) }} /><span>{cluster.label}</span><small>{cluster.member_count}</small>
        </button>
        {(expanded === cluster.id || view.regions.includes(cluster.label)) && <p>{cluster.gloss}</p>}
      </div>)}
      {data.stats.noise_count > 0 && <button onClick={() => onRegion('Unclustered')} aria-pressed={view.regions.includes('Unclustered')}>Unclustered <small>{data.stats.noise_count}</small></button>}
    </section>
    <details className="guide-method"><summary>How this map works</summary>
      <p>Each README is normalized to a fixed schema, embedded by meaning, clustered in full-dimensional space, then projected here. Distance is an approximation; nearest-neighbor lists use the original embeddings.</p>
      <p>Region colors distinguish groups; point colors identify languages. Other combines less common languages.</p>
      <p>Generated {data.generated_at.slice(0, 10)}{data.embedding_model && <> · {data.embedding_model}</>}</p>
      <a href="/atlas-list.html">Plain HTML list</a><a href="https://github.com/hbmartin/repo-atlas">Source & method ↗</a>
    </details>
  </div>
}
