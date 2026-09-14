import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { select } from 'd3-selection'
import 'd3-transition'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import type { AtlasData, AtlasRepo, MapNavigationRequest, SelectionOptions, ViewState } from '../types'
import { COMPACT_MEDIA_QUERY, formatDate, mobileMapTargetY, nearestRepoAtPoint, nearestRepoInDirection, pointerToMapPoint, useMediaQuery, useReducedMotion } from '../view-utils'
import { UNKNOWN_LANGUAGE_COLOR, type AtlasPresentation } from '../presentation'
import { atlasBounds, boundsOf, BoxGrid, constrainMapTransform, fitBounds, fitOverview, overlaps, placeRegionLabels, prepareRegionLabels, resizeTransform, smoothRing, type Box, type Size } from '../map-geometry'

const PLACEHOLDER_SIZE = { width: 1000, height: 700 }
type ClickGesture = {
  token: number; kind: 'repo' | 'region'; target: AtlasRepo | string | null
  selection: AtlasRepo | null; camera: ZoomTransform; committed: boolean
  timer?: ReturnType<typeof setTimeout>
}
type Viewport = {
  size: Size
  fit: ZoomTransform
  transform: ZoomTransform
  measured: boolean
  alt: boolean
  layoutToken: object
}
const sameTransform = (a: ZoomTransform, b: ZoomTransform) => a.x === b.x && a.y === b.y && a.k === b.k

export function MapView({ data, presentation, view, visible, selected, onSelect, navigationRequest = null, onNavigationHandled, highlightRegion = null, onRegion }: {
  data: AtlasData; presentation: AtlasPresentation; view: ViewState; visible: Set<string>; selected: AtlasRepo | null
  onSelect: (repo: AtlasRepo | null, options?: SelectionOptions) => void
  navigationRequest?: MapNavigationRequest | null; onNavigationHandled?: (nonce: number) => void
  highlightRegion?: number | null; onRegion?: (label: string, clickToken?: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const transformRef = useRef(zoomIdentity)
  const navigated = useRef(false)
  const [hover, setHover] = useState<AtlasRepo | null>(null)
  const [focused, setFocused] = useState<AtlasRepo | null>(null)
  const [hoverRegion, setHoverRegion] = useState<number | null>(null)
  const [focusedRegion, setFocusedRegion] = useState<number | null>(null)
  const [tooltip, setTooltip] = useState({ x: 0, y: 0 })
  const consumedRequest = useRef<number | null>(null)
  const previousView = useRef(view)
  const pointerStart = useRef<{ x: number; y: number; type: string; dragged: boolean } | null>(null)
  const clickGesture = useRef<ClickGesture | null>(null)
  const clickSequence = useRef(0)
  const frame = useRef<number | null>(null)
  const compact = useMediaQuery(COMPACT_MEDIA_QUERY)
  const reduced = useReducedMotion()
  const fontSize = compact ? 12 : 13
  const { sizes, colors, languageColors, reposByName, clustersById } = presentation
  const cancelClick = useCallback(() => {
    if (clickGesture.current?.timer) clearTimeout(clickGesture.current.timer)
    clickGesture.current = null
  }, [])
  const measure = useMemo(() => {
    const context = typeof CanvasRenderingContext2D === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    if (context) context.font = `700 ${fontSize}px ui-sans-serif, sans-serif`
    return (text: string) => context?.measureText(text).width ?? text.length * fontSize * .57
  }, [fontSize])
  const measureRepo = useMemo(() => {
    const context = typeof CanvasRenderingContext2D === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    if (context) context.font = '600 11px ui-monospace, monospace'
    return (text: string) => context?.measureText(text).width ?? text.length * 6.6
  }, [])
  const bounds = useMemo(() => atlasBounds(data, view.layoutAlt), [data, view.layoutAlt])
  const preparedLabels = useMemo(() => prepareRegionLabels(data, view.layoutAlt, measure, fontSize), [data, view.layoutAlt, measure, fontSize])
  const [viewport, setViewport] = useState<Viewport>(() => {
    const fit = fitOverview(data, view.layoutAlt, PLACEHOLDER_SIZE, sizes.radius, measure, fontSize, preparedLabels)
    return { size: PLACEHOLDER_SIZE, fit, transform: fit, measured: false, alt: view.layoutAlt, layoutToken: preparedLabels }
  })
  const viewportRef = useRef(viewport)
  useLayoutEffect(() => { viewportRef.current = viewport }, [viewport])
  const { size, fit, transform } = viewport
  const pointX = useCallback((repo: AtlasRepo) => view.layoutAlt ? repo.x_alt : repo.x, [view.layoutAlt])
  const pointY = useCallback((repo: AtlasRepo) => view.layoutAlt ? repo.y_alt : repo.y, [view.layoutAlt])
  const apply = useCallback((next: ZoomTransform, animate = false) => {
    if (!svgRef.current || !zoomRef.current) return
    const constrained = constrainMapTransform(next, size, bounds)
    const selection = select(svgRef.current).interrupt()
    if (animate && !reduced) selection.transition().duration(250).call(zoomRef.current.transform, constrained)
    else selection.call(zoomRef.current.transform, constrained)
  }, [reduced, size, bounds])
  const availableCenter = useCallback((): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect()
    const top = document.querySelector<HTMLElement>('.detail-panel.populated')?.getBoundingClientRect().top
    return [size.width / 2, compact && selected && rect ? mobileMapTargetY(rect, top ?? rect.bottom) : (size.height - 48) / 2]
  }, [compact, selected, size])
  const centerRepo = useCallback((repo: AtlasRepo) => {
    const [x, y] = availableCenter()
    navigated.current = true
    apply(zoomIdentity.translate(x, y).scale(Math.max(fit.k * 2.2, transformRef.current.k)).translate(-pointX(repo), -pointY(repo)), true)
  }, [apply, availableCenter, fit.k, pointX, pointY])

  useLayoutEffect(() => {
    const node = svgRef.current!
    const behavior = zoom<SVGSVGElement, unknown>()
      .extent((): [[number, number], [number, number]] => [[0, 0], [node.getBoundingClientRect().width, node.getBoundingClientRect().height]])
      .on('zoom', event => {
        transformRef.current = event.transform
        if (event.sourceEvent) {
          navigated.current = true
          cancelClick()
          if (frame.current == null) frame.current = requestAnimationFrame(() => {
            frame.current = null
            const next = transformRef.current
            setViewport(current => sameTransform(current.transform, next) ? current : { ...current, transform: next })
          })
        } else {
          if (frame.current != null) cancelAnimationFrame(frame.current)
          frame.current = null
          setViewport(current => sameTransform(current.transform, event.transform) ? current : { ...current, transform: event.transform })
        }
      })
    zoomRef.current = behavior
    select(node).call(behavior).on('dblclick.zoom', null)
    return () => {
      select(node).interrupt().on('.zoom', null)
      cancelClick()
      if (frame.current != null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [cancelClick])

  useLayoutEffect(() => {
    const node = svgRef.current!
    const resize = () => {
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const current = viewportRef.current
      const nextSize = current.size.width === rect.width && current.size.height === rect.height
        ? current.size : { width: rect.width, height: rect.height }
      const inputsChanged = current.layoutToken !== preparedLabels
      if (current.measured && nextSize === current.size && !inputsChanged) return
      const nextFit = fitOverview(data, view.layoutAlt, nextSize, sizes.radius, measure, fontSize, preparedLabels)
      const projectionChanged = current.alt !== view.layoutAlt
      if (projectionChanged) {
        navigated.current = false
        cancelClick()
      }
      const camera = !current.measured || projectionChanged || !navigated.current
        ? nextFit
        : resizeTransform(transformRef.current, current.size, nextSize, current.fit, nextFit)
      const nextTransform = constrainMapTransform(camera, nextSize, bounds)
      transformRef.current = nextTransform
      setViewport({
        size: nextSize, fit: nextFit, transform: nextTransform, measured: true,
        alt: view.layoutAlt, layoutToken: preparedLabels,
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    resize()
    return () => observer.disconnect()
  }, [data, view.layoutAlt, sizes, measure, fontSize, preparedLabels, bounds, cancelClick])

  useLayoutEffect(() => {
    if (!viewport.measured || viewport.alt !== view.layoutAlt) return
    zoomRef.current?.scaleExtent([fit.k * .6, fit.k * 10])
      .constrain(next => constrainMapTransform(next, size, bounds))
    apply(transformRef.current)
  }, [viewport.measured, viewport.alt, view.layoutAlt, fit.k, size, bounds, apply])

  const centeredProjection = useRef(view.layoutAlt)
  useLayoutEffect(() => {
    if (!viewport.measured || centeredProjection.current === viewport.alt) return
    centeredProjection.current = viewport.alt
    if (selected && !navigationRequest) centerRepo(selected)
  }, [viewport.measured, viewport.alt, selected, navigationRequest, centerRepo])

  useLayoutEffect(() => {
    if (!navigationRequest || consumedRequest.current === navigationRequest.nonce) return
    if (navigationRequest.clickToken !== clickGesture.current?.token) cancelClick()
    if (!viewport.measured || viewport.alt !== view.layoutAlt) return
    consumedRequest.current = navigationRequest.nonce
    if (navigationRequest.kind === 'repo') {
      const repo = reposByName.get(navigationRequest.target)
      if (repo) centerRepo(repo)
    } else {
      const cluster = data.clusters.find(c => c.label === navigationRequest.target)
      const members = data.repos.filter(repo => navigationRequest.target === 'Unclustered' ? repo.cluster_id == null : cluster != null && repo.cluster_id === cluster.id)
      if (members.length) {
        navigated.current = true
        const next = fitBounds(boundsOf(members.map(repo => [pointX(repo), pointY(repo)])), size, 60, 90)
        const k = Math.min(fit.k * 4, next.k)
        const center = next.invert([size.width / 2, (size.height - 30) / 2])
        apply(zoomIdentity.translate(size.width / 2, (size.height - 30) / 2).scale(k).translate(-center[0], -center[1]))
      }
    }
    onNavigationHandled?.(navigationRequest.nonce)
  }, [navigationRequest, viewport.measured, viewport.alt, view.layoutAlt, data, reposByName, pointX, pointY, size, fit.k, apply, centerRepo, onNavigationHandled, cancelClick])

  useLayoutEffect(() => {
    const old = previousView.current
    previousView.current = view
    const gesture = clickGesture.current
    if (!gesture || old === view) return
    const filtersChanged = old.languages !== view.languages || old.regions !== view.regions || old.since !== view.since
    const ownSelection = gesture.kind === 'repo' && !filtersChanged
      && view.repo === ((gesture.target as AtlasRepo | null)?.full_name ?? null)
    const ownRegion = gesture.kind === 'region' && view.regions.length === 1 && view.regions[0] === gesture.target
      && old.languages === view.languages && old.since === view.since
    if (!gesture.committed || (!ownSelection && !ownRegion)) cancelClick()
  }, [view, cancelClick])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!selected || event.defaultPrevented || svgRef.current?.closest('[inert]')) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
      if (event.key === 'Escape') { event.preventDefault(); cancelClick(); onSelect(null); return }
      const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
      if (!direction) return
      const next = nearestRepoInDirection(data.repos, visible, selected, direction, 0, view.layoutAlt)
      if (next) { event.preventDefault(); cancelClick(); onSelect(next) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [data.repos, visible, selected, onSelect, view.layoutAlt, cancelClick])

  const relativeZoom = transform.k / fit.k
  const activeRepo = hover && visible.has(hover.full_name) ? hover : focused && visible.has(focused.full_name) ? focused : null
  const drawnRadius = useCallback((repo: AtlasRepo) => sizes.radius(repo.file_count) / fit.k * (repo === selected || repo === activeRepo ? 1.3 : 1), [sizes, fit.k, selected, activeRepo])
  const paths = useMemo(() => data.clusters.flatMap(cluster => (view.layoutAlt ? cluster.contours_alt ?? cluster.contours : cluster.contours).outer.map((ring, index) => ({
    id: cluster.id, key: `${cluster.id}-${index}`, path: `M${smoothRing(ring).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z`,
  }))), [data.clusters, view.layoutAlt])
  const labels = useMemo(() => placeRegionLabels(data, view.layoutAlt, transform, size, count => sizes.radius(count) * relativeZoom, measure, fontSize, preparedLabels), [data, view.layoutAlt, transform, size, sizes, relativeZoom, measure, fontSize, preparedLabels])
  const repoText = useMemo(() => new Map(data.repos.map(repo => {
    let text = repo.name
    const maxWidth = Math.min(280, size.width - 28)
    while (text.length > 1 && measureRepo(text) > maxWidth) text = text.slice(0, -1)
    if (text !== repo.name) text = text.slice(0, -1) + '…'
    return [repo.full_name, { text, width: measureRepo(text) + 12 }]
  })), [data.repos, size.width, measureRepo])
  const repoLabels = useMemo(() => {
    const result: { repo: AtlasRepo; text: string; x: number; y: number; box: Box }[] = []
    const grid = new BoxGrid()
    const candidates = [...new Set([activeRepo, selected, ...(relativeZoom >= 1.8 ? data.repos : [])].filter((repo): repo is AtlasRepo => Boolean(repo) && visible.has(repo!.full_name)))]
    for (const repo of candidates) {
      const [px, py] = transform.apply([pointX(repo), pointY(repo)])
      if (px < 0 || px > size.width || py < 0 || py > size.height - 70) continue
      const { text, width } = repoText.get(repo.full_name)!
      const x = Math.max(8, Math.min(size.width - width - 8, px + drawnRadius(repo) * transform.k + 7))
      const y = Math.max(20, py - 10)
      const box = { left: x, right: x + width, top: y - 14, bottom: y + 5 }
      if (grid.hits(box)) continue
      grid.add(box)
      result.push({ repo, text, x, y, box })
    }
    return result
  }, [activeRepo, selected, relativeZoom, data.repos, visible, transform, pointX, pointY, size, repoText, drawnRadius])
  const renderedLabels = useMemo(() => labels.filter(label => !repoLabels.some(other => overlaps(label, other.box))), [labels, repoLabels])
  const renderedLabelIds = new Set(renderedLabels.map(label => label.id))
  if (hoverRegion != null && !renderedLabelIds.has(hoverRegion)) setHoverRegion(null)
  if (focusedRegion != null && !renderedLabelIds.has(focusedRegion)) setFocusedRegion(null)
  const activeRegion = activeRepo?.cluster_id ?? hoverRegion ?? focusedRegion ?? highlightRegion ?? selected?.cluster_id
  const hitRepo = (clientX: number, clientY: number) => {
    const point = pointerToMapPoint(clientX, clientY, svgRef.current!.getBoundingClientRect(), transformRef.current)
    return nearestRepoAtPoint(data.repos, visible, point.x, point.y, 22 * point.unitsPerPixel, view.layoutAlt, drawnRadius, selected?.full_name)
  }
  const changeZoom = (factor: number) => {
    cancelClick()
    const current = transformRef.current
    const center = availableCenter()
    const point = current.invert(center)
    const k = Math.max(fit.k * .6, Math.min(fit.k * 10, current.k * factor))
    navigated.current = true
    apply(zoomIdentity.translate(...center).scale(k).translate(-point[0], -point[1]), true)
  }
  const zoomAtPointer = (clientX: number, clientY: number, current = transformRef.current) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const pointer: [number, number] = [clientX - rect.left, clientY - rect.top]
    const point = current.invert(pointer)
    const k = Math.max(fit.k * .6, Math.min(fit.k * 10, current.k * 2))
    navigated.current = true
    apply(zoomIdentity.translate(...pointer).scale(k).translate(-point[0], -point[1]), true)
  }
  const commitClick = (gesture: ClickGesture) => {
    gesture.committed = true
    gesture.timer = undefined
    if (gesture.kind === 'repo') onSelect(gesture.target as AtlasRepo | null, { clickToken: gesture.token })
    else onRegion?.(gesture.target as string, gesture.token)
  }
  const queueClick = (kind: 'repo' | 'region', target: AtlasRepo | string | null) => {
    cancelClick()
    const gesture: ClickGesture = { token: ++clickSequence.current, kind, target, selection: selected, camera: transformRef.current, committed: false }
    gesture.timer = setTimeout(() => commitClick(gesture), 300)
    clickGesture.current = gesture
  }
  const selectImmediately = (repo: AtlasRepo | null) => { cancelClick(); onSelect(repo) }
  return <div className="map-shell">
    <svg ref={svgRef} className="atlas-map" viewBox={`0 0 ${size.width} ${size.height}`} role="group" aria-label="Semantic map of public GitHub repositories"
      onPointerDown={event => { pointerStart.current = { x: event.clientX, y: event.clientY, type: event.pointerType, dragged: false } }}
      onPointerMove={event => {
        const start = pointerStart.current
        if (start && event.buttons !== 0 && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) { start.dragged = true; cancelClick() }
      }}
      onPointerLeave={() => { setHover(null); setHoverRegion(null) }}
      onPointerCancel={() => { pointerStart.current = null; cancelClick() }}
      onClick={event => {
        if (event.detail === 0) return
        const start = pointerStart.current; pointerStart.current = null
        if (start?.dragged) return
        if (event.detail > 1) return
        const repo = hitRepo(event.clientX, event.clientY)
        if (start?.type === 'touch') selectImmediately(repo)
        else queueClick('repo', repo)
      }}
      onDoubleClick={event => {
        event.preventDefault()
        const gesture = clickGesture.current
        cancelClick()
        // A completed region focus may move the label out from under the second
        // click, making the browser dispatch dblclick on its SVG ancestor.
        if (gesture?.kind === 'region') {
          if (!gesture.committed) onRegion?.(gesture.target as string)
          return
        }
        if (gesture?.kind === 'repo' && gesture.committed) onSelect(gesture.selection, { navigate: false })
        zoomAtPointer(event.clientX, event.clientY, gesture?.kind === 'repo' ? gesture.camera : undefined)
      }}>
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
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectImmediately(repo) } }}
          onClick={event => { if (event.detail === 0) { event.stopPropagation(); selectImmediately(repo) } }}>
          <circle role="button" tabIndex={visible.has(repo.full_name) ? 0 : -1} aria-label={`${repo.name}: ${repo.one_liner}`}
            r={drawnRadius(repo)} fill={repo.low_confidence ? '#07131d' : (languageColors.get(repo.primary_language) ?? UNKNOWN_LANGUAGE_COLOR)}
            stroke={repo.low_confidence ? (languageColors.get(repo.primary_language) ?? UNKNOWN_LANGUAGE_COLOR) : '#06131d'} />
        </g>)}
      </g>
      <g className="region-leaders" aria-hidden="true">
        {labels.map(label => {
          const cluster = clustersById.get(label.id)!
          const anchor = view.layoutAlt ? cluster.label_anchor_alt ?? cluster.label_anchor : cluster.label_anchor
          const [x, y] = transform.apply([anchor.x, anchor.y])
          if (Math.hypot(label.x - x, label.y - y) < 28 || repoLabels.some(other => overlaps(label, other.box))) return null
          const endX = Math.max(label.left + 4, Math.min(label.right - 4, x))
          const endY = Math.max(label.top + 4, Math.min(label.bottom - 4, y))
          return <line key={label.id} x1={x} y1={y} x2={endX} y2={endY} stroke={colors.get(label.id)} />
        })}
      </g>
      <g className="map-labels">
        {renderedLabels.map(label => {
          const cluster = clustersById.get(label.id)!
          return <g key={label.id} className={`cluster-label ${activeRegion === label.id ? 'active' : ''}`}
            transform={`translate(${label.x} ${label.y})`} opacity={relativeZoom > 2.5 && activeRegion !== label.id ? .3 : 1}
            role="button" tabIndex={0} aria-label={`Focus region: ${cluster.label}`}
            onPointerDown={event => { pointerStart.current = null; event.stopPropagation() }}
            onClick={event => {
              event.stopPropagation()
              if (event.detail === 0) { cancelClick(); onRegion?.(cluster.label) }
              else if (event.detail === 1) queueClick('region', cluster.label)
            }}
            onDoubleClick={event => {
              event.preventDefault(); event.stopPropagation()
              const gesture = clickGesture.current
              cancelClick()
              if (!gesture?.committed) onRegion?.(cluster.label)
            }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); cancelClick(); onRegion?.(cluster.label) } }}
            onPointerEnter={() => setHoverRegion(label.id)} onPointerLeave={() => setHoverRegion(null)} onFocus={() => setFocusedRegion(label.id)} onBlur={() => setFocusedRegion(null)}>
            <text style={{ fontSize }}>{label.lines.map((line, i) => <tspan x="0" y={(i - (label.lines.length - 1) / 2) * (fontSize + 3) + fontSize * .35} key={i}>{line}</tspan>)}</text>
          </g>
        })}
        {repoLabels.map(label => <text key={label.repo.full_name} className="repo-label" x={label.x} y={label.y}>{label.text}</text>)}
      </g>
    </svg>
    <div className="map-navigation" style={compact && selected ? { bottom: 'calc(60dvh + 12px)' } : undefined}>
      <p className="map-instructions"><span className="desktop-hint">Hover to preview · Click to explore · Scroll or double-click to zoom</span><span className="touch-hint">Tap to explore · Drag to pan · Pinch to zoom</span></p>
      <div className="map-hud"><button aria-label="Zoom out" onClick={() => changeZoom(1 / 1.25)}>−</button><span aria-label="Zoom level">{Math.round(relativeZoom * 100)}%</span><button aria-label="Zoom in" onClick={() => changeZoom(1.25)}>+</button><button onClick={() => { cancelClick(); navigated.current = false; apply(fit, true) }}>Reset view</button></div>
    </div>
    {activeRepo && <div className="tooltip" role="tooltip" style={{ left: Math.max(8, Math.min(tooltip.x + 14, window.innerWidth - 284)), top: Math.max(8, Math.min(tooltip.y + 14, window.innerHeight - 160)) }}>
      <strong>{activeRepo.name}</strong><span>{activeRepo.one_liner}</span><small>{activeRepo.primary_language} · updated {formatDate(activeRepo.pushed_at)}</small>
      {activeRepo.low_confidence && <small>Sparse README / low-confidence summary</small>}
    </div>}
  </div>
}
