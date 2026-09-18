import { useMemo, useState } from 'react'
import type { AtlasData, ViewState } from '../types'
import { regionGuideOptions, type AtlasPresentation } from '../presentation'
import { FallbackLabel, FALLBACK_LABEL_EXPLANATION } from './FallbackLabel'

export function AtlasGuide({ data, presentation, view, onLanguage, onRegion, onHighlight }: {
  data: AtlasData; presentation: AtlasPresentation; view: ViewState; onLanguage: (name: string, included: boolean) => void
  onRegion: (name: string) => void; onHighlight: (id: number | null) => void
}) {
  const { languages, sizes, colors } = presentation
  const currentRegion = view.regions.length === 1 ? view.regions[0] : null
  const fallbackLabels = useMemo(() => new Set(data.fallback_label_ids ?? []), [data.fallback_label_ids])
  const [expanded, setExpanded] = useState<number | null>(null)
  const { clusteredRegions, unclustered } = regionGuideOptions(data)
  return <div className="atlas-guide">
    <header><span className="eyebrow">EXPLORE THE LANDSCAPE</span><h2>Atlas guide</h2>
      <p>One point, one repository. Nearby projects share ideas and techniques.</p></header>
    <p className="guide-instructions"><span className="desktop-hint">Hover to preview · Click to explore</span><span className="touch-hint">Tap a point to explore</span><br />Drag to pan · <span className="desktop-hint">Scroll or double-click to zoom</span><span className="touch-hint">Pinch to zoom</span> · <kbd>/</kbd> to search</p>
    <section aria-label="Language legend"><h3>Language <small>all repositories</small></h3>
      <div className="guide-languages">{languages.filter(language => language.count > 0).map(language => {
        const included = view.languages.includes(language.name)
        return <button key={language.name}
          aria-label={`Filter by ${language.name}: ${language.count} repositories`} aria-pressed={included} onClick={() => onLanguage(language.name, !included)}>
          <i style={{ background: language.color }} /><span>{language.name}</span><small>{language.count}</small>
        </button>
      })}</div>
    </section>
    <section className="guide-size" aria-label="Repository size legend"><h3>Size <small>tracked files</small></h3>
      <div className="size-examples">{sizes.examples.map(count => <span key={count}><i style={{ width: sizes.radius(count) * 2, height: sizes.radius(count) * 2 }} /><small>{count.toLocaleString()}</small></span>)}</div>
      <p>Logarithmic scale; extremes capped. Missing counts use the smallest point.</p>
      <p className="confidence-key"><i />Sparse README / low-confidence summary</p>
    </section>
    <section className="guide-regions"><h3>Regions <small>select to focus</small></h3>
      {clusteredRegions.map(region => {
        const cluster = region.cluster!
        return <div key={cluster.id}>
        <button aria-current={currentRegion === cluster.label ? 'true' : undefined} onClick={() => onRegion(cluster.label)}
          onPointerEnter={() => { onHighlight(cluster.id); setExpanded(cluster.id) }}
          onPointerLeave={() => { onHighlight(null); setExpanded(null) }}
          onFocus={() => { onHighlight(cluster.id); setExpanded(cluster.id) }}
          onBlur={() => { onHighlight(null); setExpanded(null) }}>
          <i style={{ background: colors.get(cluster.id) }} /><span>{cluster.label} {fallbackLabels.has(cluster.id) && <FallbackLabel />}</span><small>{cluster.member_count}</small>
        </button>
        {(expanded === cluster.id || view.regions.includes(cluster.label)) && <p>{cluster.gloss}
          {fallbackLabels.has(cluster.id) && <span className="fallback-explanation">{FALLBACK_LABEL_EXPLANATION}</span>}
        </p>}
      </div>
      })}
      {unclustered && <button onClick={() => onRegion(unclustered.label)} aria-current={currentRegion === unclustered.label ? 'true' : undefined}>{unclustered.label} <small>{unclustered.count}</small></button>}
    </section>
    <details className="guide-method"><summary>How this map works</summary>
      <p>Each README is normalized to a fixed schema, embedded by meaning, clustered in full-dimensional space, then projected here. Distance is an approximation; nearest-neighbor lists use the original embeddings.</p>
      <p>Region colors distinguish groups; point colors identify languages. Language categories and colors come from the generated atlas; Other combines languages grouped by the pipeline.</p>
      <p>Generated {data.generated_at.slice(0, 10)}{data.embedding_model && <> · {data.embedding_model}</>}</p>
      <a href="/atlas-list.html">Plain HTML list</a><a href="https://github.com/hbmartin/repo-atlas">Source & method ↗</a>
    </details>
  </div>
}
