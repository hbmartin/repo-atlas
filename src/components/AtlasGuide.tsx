import { useMemo, useRef } from 'react'
import type { AtlasData, ViewState } from '../types'
import { regionGuideOptions, regionKey, UNCLUSTERED_KEY, type AtlasPresentation } from '../presentation'
import { FallbackLabel, FALLBACK_LABEL_EXPLANATION } from './FallbackLabel'

export function AtlasGuide({ data, presentation, view, onLanguage, onRegion, onHighlight, onLanguagePreview }: {
  data: AtlasData; presentation: AtlasPresentation; view: ViewState; onLanguage: (name: string, included: boolean) => void
  onLanguagePreview?: (name: string | null) => void
  onRegion: (name: string, opener: HTMLButtonElement) => void; onHighlight: (id: number | null) => void
}) {
  const { languages, sizes, colors } = presentation
  const preview = useRef<{ pointer: string | null; focus: string | null }>({ pointer: null, focus: null })
  const previewLanguage = (source: 'pointer' | 'focus', name: string | null) => {
    preview.current[source] = name
    onLanguagePreview?.(preview.current.pointer ?? preview.current.focus)
  }
  const fallbackLabels = useMemo(() => new Set(data.fallback_label_ids ?? []), [data.fallback_label_ids])
  const { clusteredRegions, unclustered } = regionGuideOptions(data)
  return <div className="atlas-guide">
    <header><span className="eyebrow">EXPLORE THE LANDSCAPE</span><h2>Atlas guide</h2>
      <p>One point, one repository. Select a territory to explore its work.</p></header>
    <section aria-label="Language legend"><h3>Language <small>all repositories</small></h3>
      <div className="guide-languages">{languages.filter(language => language.count > 0).map(language => {
        const included = view.languages.includes(language.name)
        return <button key={language.name}
          aria-label={`Filter by ${language.name}: ${language.count} repositories`} aria-pressed={included}
          onPointerEnter={event => { if (event.pointerType !== 'touch') previewLanguage('pointer', language.name) }}
          onPointerLeave={() => previewLanguage('pointer', null)}
          onFocus={() => previewLanguage('focus', language.name)} onBlur={() => previewLanguage('focus', null)}
          onClick={event => {
            if (event.detail > 0) previewLanguage('focus', null)
            onLanguage(language.name, !included)
          }}>
          <i style={{ background: language.color }} /><span>{language.name}</span><small>{language.count}</small>
        </button>
      })}</div>
    </section>
    <section className="guide-size" aria-label="Repository size legend"><h3>Size <small>tracked files</small></h3>
      <div className="size-examples">{sizes.examples.map(count => <span key={count}><i style={{ width: sizes.radius(count) * 2, height: sizes.radius(count) * 2 }} /><small>{count.toLocaleString()}</small></span>)}</div>
      <p>Logarithmic scale; extremes capped. Missing counts use the smallest point.</p>
    </section>
    <section className="guide-regions"><h3>Regions <small>select to focus</small></h3>
      {clusteredRegions.map(region => {
        const cluster = region.cluster!
        return <div key={cluster.id}>
        <button data-region-opener={regionKey(cluster)} aria-current={view.focusedRegion === regionKey(cluster) ? 'true' : undefined} onClick={event => onRegion(cluster.label, event.currentTarget)}
          onPointerEnter={() => onHighlight(cluster.id)}
          onPointerLeave={() => onHighlight(null)}
          onFocus={() => onHighlight(cluster.id)}
          onBlur={() => onHighlight(null)}>
          <i style={{ background: colors.get(cluster.id) }} /><span>{cluster.label} {fallbackLabels.has(cluster.id) && <FallbackLabel />}</span><small>{cluster.member_count}</small>
        </button>
        <p>{cluster.gloss}
          {fallbackLabels.has(cluster.id) && <span className="fallback-explanation">{FALLBACK_LABEL_EXPLANATION}</span>}
        </p>
      </div>
      })}
      {unclustered && <button data-region-opener={UNCLUSTERED_KEY} onClick={event => onRegion(unclustered.label, event.currentTarget)} aria-current={view.focusedRegion === UNCLUSTERED_KEY ? 'true' : undefined}>{unclustered.label} <small>{unclustered.count}</small></button>}
    </section>
    <details className="guide-method"><summary>How this map works</summary>
      <p>Each README is normalized to a fixed schema, embedded by meaning, clustered in full-dimensional space, then projected here. Territories separate groups for readability. The semantic view shows the original projection, and nearest neighbors come from the embeddings.</p>
      <p>Region colors distinguish groups; point colors identify languages. Language categories and colors come from the generated atlas; Other combines languages grouped by the pipeline.</p>
      <p>Generated {data.generated_at.slice(0, 10)}{data.embedding_model && <> · {data.embedding_model}</>}</p>
      <a href="/atlas-list.html">Plain HTML list</a><a href="https://github.com/hbmartin/repo-atlas">Source & method ↗</a>
    </details>
  </div>
}
