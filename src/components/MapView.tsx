import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { select } from 'd3-selection'
import 'd3-transition'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import type { AtlasData, AtlasRepo, ViewState } from '../types'
import { formatDate, mobileMapTargetY, nearestRepoAtPoint, nearestRepoInDirection, pointerToMapPoint, useMediaQuery, useReducedMotion } from '../view-utils'
import { displayLanguage, fileSizeScale, LANGUAGE_COLORS, regionColors } from '../presentation'
import { boundsOf, fitBounds, fitOverview, overlaps, placeRegionLabels, resizeTransform, smoothRing, type Box, type Size } from '../map-geometry'

export function MapView({ data, view, visible, selected, onSelect, regionRequest = null, highlightRegion = null, onHighlight, onRegion }: {
  data: AtlasData; view: ViewState; visible: Set<string>; selected: AtlasRepo | null
  onSelect: (repo: AtlasRepo | null) => void
  regionRequest?: { label: string; nonce: number } | null
  highlightRegion?: number | null; onHighlight?: (id: number | null) => void; onRegion?: (label: string) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const transformRef = useRef(zoomIdentity)
  const navigated = useRef(false)
  const [transform, setTransform] = useState(zoomIdentity)
  const [size, setSize] = useState<Size>({ width: 1000, height: 700 })
  const [hover, setHover] = useState<AtlasRepo | null>(null)
  const [focused, setFocused] = useState<AtlasRepo | null>(null)
  const [tooltip, setTooltip] = useState({ x: 0, y: 0 })
  const consumedRegionRequest = useRef<number | null>(null)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const compact = useMediaQuery('(max-width: 1023px)')
  const reduced = useReducedMotion()
  const fontSize = compact ? 12 : 13
  const sizes = useMemo(() => fileSizeScale(data.repos), [data.repos])
  const colors = useMemo(() => regionColors(data), [data])
  const measure = useMemo(() => {
    // Canvas is absent in the DOM-only test environment. Browser measurements use the rendered font.
    const context = typeof CanvasRenderingContext2D === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    if (context) context.font = `700 ${fontSize}px ui-sans-serif, sans-serif`
    return (text: string) => context?.measureText(text).width ?? text.length * fontSize * .57
  }, [fontSize])
  const measureRepo = useMemo(() => {
    const context = typeof CanvasRenderingContext2D === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    if (context) context.font = '600 11px ui-monospace, monospace'
    return (text: string) => context?.measureText(text).width ?? text.length * 6.6
  }, [])
  const fit = useMemo(() => fitOverview(data, view.layoutAlt, size, sizes.radius, measure, fontSize), [data, view.layoutAlt, size, sizes, measure, fontSize])
  const previous = useRef<{ size: Size; fit: ZoomTransform; alt: boolean } | null>(null)
  const pointX = useCallback((repo: AtlasRepo) => view.layoutAlt ? repo.x_alt : repo.x, [view.layoutAlt])
  const pointY = useCallback((repo: AtlasRepo) => view.layoutAlt ? repo.y_alt : repo.y, [view.layoutAlt])
  const apply = useCallback((next: ZoomTransform, animate = false) => {
    if (!svgRef.current || !zoomRef.current) return
    const selection = select(svgRef.current).interrupt()
    if (animate && !reduced) selection.transition().duration(250).call(zoomRef.current.transform, next)
    else selection.call(zoomRef.current.transform, next)
  }, [reduced])

  useLayoutEffect(() => {
    const node = svgRef.current!
    const resize = () => {
      const bounds = node.getBoundingClientRect()
      if (bounds.width > 0 && bounds.height > 0) setSize(current => current.width === bounds.width && current.height === bounds.height ? current : { width: bounds.width, height: bounds.height })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    resize()
    const behavior = zoom<SVGSVGElement, unknown>()
      .extent((): [[number, number], [number, number]] => [[0, 0], [node.clientWidth || 1000, node.clientHeight || 700]])
      .on('zoom', event => {
        if (event.sourceEvent) navigated.current = true
        transformRef.current = event.transform
        setTransform(event.transform)
      })
    zoomRef.current = behavior
    select(node).call(behavior).on('dblclick.zoom', null)
    return () => { observer.disconnect(); select(node).interrupt().on('.zoom', null) }
  }, [])

  useLayoutEffect(() => {
    zoomRef.current?.scaleExtent([fit.k * .6, fit.k * 10])
    const old = previous.current
    const layoutChanged = old && old.alt !== view.layoutAlt
    const next = !old || layoutChanged || !navigated.current ? fit : resizeTransform(transformRef.current, old.size, size, old.fit, fit)
    if (layoutChanged) navigated.current = false
    previous.current = { size, fit, alt: view.layoutAlt }
    apply(next)
  }, [fit, size, view.layoutAlt, apply])

  const availableCenter = useCallback((): [number, number] => {
    const bounds = svgRef.current?.getBoundingClientRect()
    const top = document.querySelector<HTMLElement>('.detail-panel.populated')?.getBoundingClientRect().top
    return [size.width / 2, compact && selected && bounds ? mobileMapTargetY(bounds, top ?? bounds.bottom) : (size.height - 48) / 2]
  }, [compact, selected, size])
  const centerRepo = useCallback((repo: AtlasRepo, factor = 2.2) => {
    const [x, y] = availableCenter()
    navigated.current = true
    apply(zoomIdentity.translate(x, y).scale(Math.max(fit.k * factor, transformRef.current.k)).translate(-pointX(repo), -pointY(repo)), true)
  }, [apply, availableCenter, fit.k, pointX, pointY])
  useEffect(() => { if (selected) centerRepo(selected) }, [selected, centerRepo])
  useEffect(() => {
    if (!regionRequest || consumedRegionRequest.current === regionRequest.nonce) return
    consumedRegionRequest.current = regionRequest.nonce
    const cluster = data.clusters.find(c => c.label === regionRequest.label)
    const members = data.repos.filter(repo => regionRequest.label === 'Unclustered' ? repo.cluster_id == null : repo.cluster_id === cluster?.id)
    if (!members.length) return
    navigated.current = true
    const next = fitBounds(boundsOf(members.map(repo => [pointX(repo), pointY(repo)])), size, 60, 90)
    const k = Math.min(fit.k * 4, next.k)
    const center = next.invert([size.width / 2, (size.height - 30) / 2])
    // Apply before a filter-induced header resize, so resize preserves this camera rather than interrupting a transition at its starting position.
    apply(zoomIdentity.translate(size.width / 2, (size.height - 30) / 2).scale(k).translate(-center[0], -center[1]))
  }, [regionRequest, data, pointX, pointY, size, fit.k, apply])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!selected || event.defaultPrevented || svgRef.current?.closest('[inert]')) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
      if (event.key === 'Escape') { event.preventDefault(); onSelect(null); return }
      const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
      if (!direction) return
      const next = nearestRepoInDirection(data.repos, visible, selected, direction, 0, view.layoutAlt)
      if (next) { event.preventDefault(); onSelect(next) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [data.repos, visible, selected, onSelect, view.layoutAlt])

  const relativeZoom = transform.k / fit.k
  const activeRepo = hover && visible.has(hover.full_name) ? hover : focused && visible.has(focused.full_name) ? focused : null
  const activeRegion = activeRepo?.cluster_id ?? highlightRegion ?? selected?.cluster_id
  const drawnRadius = (repo: AtlasRepo) => sizes.radius(repo.file_count) / fit.k * (repo === selected || repo === activeRepo ? 1.3 : 1)
  const paths = useMemo(() => data.clusters.flatMap(cluster => (view.layoutAlt ? cluster.contours_alt ?? cluster.contours : cluster.contours).outer.map((ring, index) => ({
    id: cluster.id, key: `${cluster.id}-${index}`, path: `M${smoothRing(ring).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z`,
  }))), [data.clusters, view.layoutAlt])
  const labels = useMemo(() => placeRegionLabels(data, view.layoutAlt, transform, size, count => sizes.radius(count) * relativeZoom, measure, fontSize), [data, view.layoutAlt, transform, size, sizes, relativeZoom, measure, fontSize])
  const reposByName = useMemo(() => new Map(data.repos.map(repo => [repo.full_name, repo])), [data.repos])
  const repoLabels: { repo: AtlasRepo; text: string; x: number; y: number; box: Box }[] = []
  const candidates = [...new Set([activeRepo, selected, ...(relativeZoom >= 1.8 ? data.repos : [])].filter((repo): repo is AtlasRepo => Boolean(repo) && visible.has(repo!.full_name)))]
  for (const repo of candidates) {
    const [px, py] = transform.apply([pointX(repo), pointY(repo)])
    if (px < 0 || px > size.width || py < 0 || py > size.height - 70) continue
    let text = repo.name
    const maxWidth = Math.min(280, size.width - 28)
    while (text.length > 1 && measureRepo(text) > maxWidth) text = text.slice(0, -1)
    if (text !== repo.name) text = text.slice(0, -1) + '…'
    const width = measureRepo(text) + 12
    const x = Math.max(8, Math.min(size.width - width - 8, px + drawnRadius(repo) * transform.k + 7))
    const y = Math.max(20, py - 10)
    const box = { left: x, right: x + width, top: y - 14, bottom: y + 5 }
    if (repoLabels.some(label => overlaps(box, label.box))) continue
    repoLabels.push({ repo, text, x, y, box })
  }
  const hitRepo = (clientX: number, clientY: number) => {
    const point = pointerToMapPoint(clientX, clientY, svgRef.current!.getBoundingClientRect(), transformRef.current)
    return nearestRepoAtPoint(data.repos, visible, point.x, point.y, 22 * point.unitsPerPixel, view.layoutAlt, drawnRadius, selected?.full_name)
  }
  const changeZoom = (factor: number) => {
    const current = transformRef.current
    const center = availableCenter()
    const point = current.invert(center)
    const k = Math.max(fit.k * .6, Math.min(fit.k * 10, current.k * factor))
    navigated.current = true
    apply(zoomIdentity.translate(...center).scale(k).translate(-point[0], -point[1]), true)
  }
  const zoomAtPointer = (clientX: number, clientY: number, factor = 2) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds) return
    const current = transformRef.current
    const pointer: [number, number] = [clientX - bounds.left, clientY - bounds.top]
    const point = current.invert(pointer)
    const k = Math.max(fit.k * .6, Math.min(fit.k * 10, current.k * factor))
    navigated.current = true
    apply(zoomIdentity.translate(...pointer).scale(k).translate(-point[0], -point[1]), true)
  }

  return <div className="map-shell">
    <svg ref={svgRef} className="atlas-map" viewBox={`0 0 ${size.width} ${size.height}`} role="group" aria-label="Semantic map of public GitHub repositories"
      onPointerDown={event => { pointerStart.current = { x: event.clientX, y: event.clientY } }}
      onPointerCancel={() => { pointerStart.current = null }}
      onClick={event => {
        if (event.detail === 0) return
        const start = pointerStart.current; pointerStart.current = null
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
        onSelect(hitRepo(event.clientX, event.clientY))
      }}
      onDoubleClick={event => { event.preventDefault(); zoomAtPointer(event.clientX, event.clientY) }}>
      <rect width={size.width} height={size.height} className="map-bg" />
      <g transform={transform.toString()} className="map-geometry">
        {paths.map(path => <path key={path.key} d={path.path} className={`contour outer ${activeRegion === path.id ? 'active' : ''}`} style={{ fill: colors.get(path.id), stroke: colors.get(path.id) }} />)}
        {selected?.neighbors.map(neighbor => reposByName.get(neighbor.full_name)).filter((repo): repo is AtlasRepo => Boolean(repo) && visible.has(repo!.full_name)).map(repo => <line key={repo.full_name} className="neighbor-line" x1={pointX(selected)} y1={pointY(selected)} x2={pointX(repo)} y2={pointY(repo)} />)}
        {data.repos.map(repo => <g key={repo.full_name} transform={`translate(${pointX(repo)} ${pointY(repo)})`}
          className={`repo-point ${repo === selected ? 'selected' : ''} ${repo.low_confidence ? 'low-confidence' : ''}`}
          opacity={visible.has(repo.full_name) ? 1 : .1} pointerEvents={visible.has(repo.full_name) ? 'auto' : 'none'}
          onPointerEnter={event => { setHover(repo); setTooltip({ x: event.clientX, y: event.clientY }) }}
          onPointerMove={event => setTooltip({ x: event.clientX, y: event.clientY })} onPointerLeave={() => setHover(null)}
          onFocus={event => { const bounds = event.currentTarget.getBoundingClientRect(); setFocused(repo); setTooltip({ x: bounds.right, y: bounds.top }) }} onBlur={() => setFocused(null)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(repo) } }}
          onClick={event => { if (event.detail === 0) { event.stopPropagation(); onSelect(repo) } }}>
          <circle role="button" tabIndex={visible.has(repo.full_name) ? 0 : -1} aria-label={`${repo.name}: ${repo.one_liner}`}
            r={drawnRadius(repo)} fill={repo.low_confidence ? '#07131d' : LANGUAGE_COLORS[displayLanguage(repo.primary_language)]}
            stroke={repo.low_confidence ? LANGUAGE_COLORS[displayLanguage(repo.primary_language)] : '#06131d'} />
        </g>)}
      </g>
      <g className="region-leaders" aria-hidden="true">
        {labels.map(label => {
          const cluster = data.clusters.find(c => c.id === label.id)!
          const anchor = view.layoutAlt ? cluster.label_anchor_alt ?? cluster.label_anchor : cluster.label_anchor
          const [x, y] = transform.apply([anchor.x, anchor.y])
          if (Math.hypot(label.x - x, label.y - y) < 28 || repoLabels.some(other => overlaps(label, other.box))) return null
          const endX = Math.max(label.left + 4, Math.min(label.right - 4, x))
          const endY = Math.max(label.top + 4, Math.min(label.bottom - 4, y))
          return <line key={label.id} x1={x} y1={y} x2={endX} y2={endY} stroke={colors.get(label.id)} />
        })}
      </g>
      <g className="map-labels">
        {labels.filter(label => !repoLabels.some(other => overlaps(label, other.box))).map(label => {
          const cluster = data.clusters.find(c => c.id === label.id)!
          return <g key={label.id} className={`cluster-label ${activeRegion === label.id ? 'active' : ''}`}
            transform={`translate(${label.x} ${label.y})`} opacity={relativeZoom > 2.5 && activeRegion !== label.id ? .3 : 1}
            role="button" tabIndex={0} aria-label={`Focus region: ${cluster.label}`}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); onRegion?.(cluster.label) }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRegion?.(cluster.label) } }}
            onPointerEnter={() => onHighlight?.(label.id)} onPointerLeave={() => onHighlight?.(null)} onFocus={() => onHighlight?.(label.id)} onBlur={() => onHighlight?.(null)}>
            <text style={{ fontSize }}>{label.lines.map((line, i) => <tspan x="0" y={(i - (label.lines.length - 1) / 2) * (fontSize + 3) + fontSize * .35} key={line}>{line}</tspan>)}</text>
          </g>
        })}
        {repoLabels.map(label => <text key={label.repo.full_name} className="repo-label" x={label.x} y={label.y}>{label.text}</text>)}
      </g>
    </svg>
    <div className="map-navigation" style={compact && selected ? { bottom: 'calc(60dvh + 12px)' } : undefined}>
      <p className="map-instructions"><span className="desktop-hint">Hover to preview · Click to explore · Scroll or double-click to zoom</span><span className="touch-hint">Tap to explore · Drag to pan · Pinch to zoom</span></p>
      <div className="map-hud"><button aria-label="Zoom out" onClick={() => changeZoom(1 / 1.25)}>−</button><span aria-label="Zoom level">{Math.round(relativeZoom * 100)}%</span><button aria-label="Zoom in" onClick={() => changeZoom(1.25)}>+</button><button onClick={() => { navigated.current = false; apply(fit, true) }}>Reset view</button></div>
    </div>
    {activeRepo && <div className="tooltip" role="tooltip" style={{ left: Math.max(8, Math.min(tooltip.x + 14, window.innerWidth - 284)), top: Math.max(8, Math.min(tooltip.y + 14, window.innerHeight - 160)) }}>
      <strong>{activeRepo.name}</strong><span>{activeRepo.one_liner}</span><small>{activeRepo.primary_language} · updated {formatDate(activeRepo.pushed_at)}</small>
      {activeRepo.low_confidence && <small>Sparse README / low-confidence summary</small>}
    </div>}
  </div>
}
