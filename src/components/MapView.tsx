import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { select } from 'd3-selection'
import { ZoomTransform, zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from 'd3-zoom'
import type { AtlasData, AtlasRepo, MapNavigationRequest, SelectionOptions, ViewState } from '../types'
import { COMPACT_MEDIA_QUERY, MAP_TRANSITION_DURATION, formatDate, mobileMapTargetY, nearestRepoAtPoint, nearestRepoInDirection, pointerToMapPoint, useMediaQuery, useReducedMotion } from '../view-utils'
import type { AtlasPresentation } from '../presentation'
import { atlasBounds, boundsOf, BoxGrid, constrainMapTransform, fitBounds, fitOverview, overlaps, placeRegionLabels, prepareRegionLabels, resizeTransform, smoothRing, type Box, type Size } from '../map-geometry'

const PLACEHOLDER_SIZE = { width: 1000, height: 700 }
const TOOLTIP_WIDTH = 270
const TOOLTIP_FALLBACK_SIZE = { width: TOOLTIP_WIDTH, height: 160 }
const easeCubicInOut = (value: number) => ((value *= 2) <= 1 ? value ** 3 : (value -= 2) * value ** 2 + 2) / 2
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
const positionTooltip = (anchor: { x: number; y: number }, tooltip: Size, viewport: Size) => ({
  left: Math.max(8, Math.min(anchor.x + 14, viewport.width - tooltip.width - 8)),
  top: Math.max(8, Math.min(anchor.y + 14, viewport.height - tooltip.height - 8)),
})
type MapTooltipProps = {
  repo: AtlasRepo | null
  setNode: (node: HTMLDivElement | null) => void
}
function MapTooltip({ repo, setNode }: MapTooltipProps) {
  if (!repo) return null
  return <div ref={setNode} className="tooltip" role="tooltip" style={{ width: TOOLTIP_WIDTH }}>
    <strong>{repo.name}</strong><span>{repo.one_liner}</span><small>{repo.primary_language} · updated {formatDate(repo.pushed_at)}</small>
    {repo.low_confidence && <small>Sparse README / low-confidence summary</small>}
  </div>
}

export function MapView({ data, presentation, view, visible, selected, onSelect, navigationRequest = null, onNavigationHandled, highlightRegion = null, onRegion }: {
  data: AtlasData; presentation: AtlasPresentation; view: ViewState; visible: Set<string>; selected: AtlasRepo | null
  onSelect: (repo: AtlasRepo | null, options?: SelectionOptions) => void
  navigationRequest?: MapNavigationRequest | null; onNavigationHandled?: (nonce: number) => void
  highlightRegion?: number | null; onRegion?: (label: string, clickToken?: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const programmaticTransform = useRef(false)
  const navigated = useRef(false)
  const [hover, setHover] = useState<AtlasRepo | null>(null)
  const [focused, setFocused] = useState<AtlasRepo | null>(null)
  const [lastReadyRepo, setLastReadyRepo] = useState<AtlasRepo | null>(null)
  const [hoverRegion, setHoverRegion] = useState<number | null>(null)
  const [focusedRegion, setFocusedRegion] = useState<number | null>(null)
  const svgOrigin = useRef({ left: 0, top: 0 })
  const lastPointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const tooltipSize = useRef<Size>(TOOLTIP_FALLBACK_SIZE)
  const tooltipMapAnchor = useRef<{ x: number; y: number } | null>(null)
  const tooltipUsesPointer = useRef(false)
  const tooltipObserver = useRef<ResizeObserver | null>(null)
  const tooltipFrame = useRef<number | null>(null)
  const tooltipOriginDirty = useRef(false)
  const consumedRequest = useRef<number | null>(null)
  const previousView = useRef(view)
  const pointerStart = useRef<{ x: number; y: number; type: string; dragged: boolean } | null>(null)
  const clickGesture = useRef<ClickGesture | null>(null)
  const clickSequence = useRef(0)
  const frame = useRef<number | null>(null)
  const animationFrame = useRef<number | null>(null)
  const animationToken = useRef(0)
  const compact = useMediaQuery(COMPACT_MEDIA_QUERY)
  const reduced = useReducedMotion()
  const fontSize = compact ? 12 : 13
  const { sizes, colors, languageColors, reposByName, clustersById } = presentation
  const dotLookup = useMemo(() => {
    const nodes = new Map<string, SVGCircleElement>()
    const refs = new Map(data.repos.map(repo => [repo.full_name, (node: SVGCircleElement | null) => {
      if (node) nodes.set(repo.full_name, node)
      else nodes.delete(repo.full_name)
    }] as const))
    return { nodes, refs }
  }, [data.repos])
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
  const targetTransformRef = useRef(viewport.transform)
  const boundsRef = useRef(bounds)
  useLayoutEffect(() => { boundsRef.current = bounds }, [bounds])
  useLayoutEffect(() => { viewportRef.current = viewport }, [viewport])
  const { size, fit, transform } = viewport
  const viewportReady = viewport.measured && viewport.alt === view.layoutAlt && viewport.layoutToken === preparedLabels
  const viewportReadyRef = useRef(false)
  useLayoutEffect(() => { viewportReadyRef.current = viewportReady }, [viewportReady])
  const refreshSvgOrigin = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (rect) svgOrigin.current = { left: rect.left, top: rect.top }
  }, [])
  const positionVisibleTooltip = useCallback((node = tooltipRef.current) => {
    if (!node || !viewportReadyRef.current) return
    if (tooltipUsesPointer.current && tooltipOriginDirty.current) {
      tooltipOriginDirty.current = false
      refreshSvgOrigin()
    }
    const pointer = lastPointer.current
    const point = tooltipUsesPointer.current && pointer
      ? { x: pointer.clientX - svgOrigin.current.left, y: pointer.clientY - svgOrigin.current.top }
      : tooltipMapAnchor.current
    if (!point) return
    const next = positionTooltip(point, tooltipSize.current, viewportRef.current.size)
    node.style.left = `${next.left}px`
    node.style.top = `${next.top}px`
  }, [refreshSvgOrigin])
  const scheduleTooltipPosition = useCallback((refreshOrigin = false, immediate = false) => {
    if (refreshOrigin) tooltipOriginDirty.current = true
    if (immediate) {
      if (tooltipFrame.current != null) cancelAnimationFrame(tooltipFrame.current)
      tooltipFrame.current = null
      positionVisibleTooltip()
    } else if (tooltipFrame.current == null) {
      tooltipFrame.current = requestAnimationFrame(() => {
        tooltipFrame.current = null
        positionVisibleTooltip()
      })
    }
  }, [positionVisibleTooltip])
  const updateTooltipPointer = useCallback((clientX: number, clientY: number, immediate = false) => {
    lastPointer.current = { clientX, clientY }
    scheduleTooltipPosition(immediate, immediate)
  }, [scheduleTooltipPosition])
  const setTooltipNode = useCallback((node: HTMLDivElement | null) => {
    const previous = tooltipRef.current
    if (previous) tooltipObserver.current?.unobserve(previous)
    tooltipRef.current = node
    if (!node) return
    tooltipSize.current = TOOLTIP_FALLBACK_SIZE
    tooltipObserver.current?.observe(node)
  }, [])
  const commitTransform = useCallback((next: ZoomTransform) => {
    if (frame.current != null) cancelAnimationFrame(frame.current)
    frame.current = null
    setViewport(current => sameTransform(current.transform, next) ? current : { ...current, transform: next })
  }, [])
  const scheduleTransform = useCallback(() => {
    if (frame.current != null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (svgRef.current) commitTransform(zoomTransform(svgRef.current))
    })
  }, [commitTransform])
  const cancelCameraAnimation = useCallback(() => {
    animationToken.current += 1
    if (animationFrame.current != null) cancelAnimationFrame(animationFrame.current)
    animationFrame.current = null
  }, [])
  const writeTransform = useCallback((next: ZoomTransform) => {
    if (!svgRef.current || !zoomRef.current) return
    programmaticTransform.current = true
    try {
      select(svgRef.current).call(zoomRef.current.transform, next)
    } finally {
      programmaticTransform.current = false
    }
  }, [])
  const animateTransform = useCallback((next: ZoomTransform) => {
    const node = svgRef.current
    const behavior = zoomRef.current
    if (!node || !behavior) return
    const rect = node.getBoundingClientRect()
    const width = Math.max(rect.width, rect.height)
    if (width <= 0) { writeTransform(next); return }
    const center: [number, number] = [rect.width / 2, rect.height / 2]
    const current = zoomTransform(node)
    if (sameTransform(current, next)) { writeTransform(next); return }
    const currentCenter = current.invert(center)
    const nextCenter = next.invert(center)
    const interpolate = behavior.interpolate()(
      [currentCenter[0], currentCenter[1], width / current.k],
      [nextCenter[0], nextCenter[1], width / next.k],
    )
    const started = performance.now()
    const token = ++animationToken.current
    const tick = () => {
      if (token !== animationToken.current) return
      const progress = Math.min(1, (performance.now() - started) / MAP_TRANSITION_DURATION)
      if (progress === 1) {
        writeTransform(next)
        animationFrame.current = null
        return
      }
      const [x, y, interpolatedWidth] = interpolate(easeCubicInOut(progress))
      const k = width / interpolatedWidth
      writeTransform(new ZoomTransform(k, center[0] - x * k, center[1] - y * k))
      animationFrame.current = requestAnimationFrame(tick)
    }
    animationFrame.current = requestAnimationFrame(tick)
  }, [writeTransform])
  const configureZoom = useCallback((behavior: ZoomBehavior<SVGSVGElement, unknown>, currentFit: ZoomTransform) => {
    behavior.scaleExtent([currentFit.k * .6, currentFit.k * 10])
      .constrain(next => constrainMapTransform(next, viewportRef.current.size, boundsRef.current))
  }, [])
  const pointX = useCallback((repo: AtlasRepo) => view.layoutAlt ? repo.x_alt : repo.x, [view.layoutAlt])
  const pointY = useCallback((repo: AtlasRepo) => view.layoutAlt ? repo.y_alt : repo.y, [view.layoutAlt])
  const apply = useCallback((next: ZoomTransform, animate = false) => {
    if (!svgRef.current || !zoomRef.current) return
    const constrained = constrainMapTransform(next, size, bounds)
    cancelCameraAnimation()
    targetTransformRef.current = constrained
    if (animate && !reduced) animateTransform(constrained)
    else writeTransform(constrained)
  }, [reduced, size, bounds, cancelCameraAnimation, animateTransform, writeTransform])
  const availableCenter = useCallback((): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect()
    const top = document.querySelector<HTMLElement>('.detail-panel.populated')?.getBoundingClientRect().top
    return [size.width / 2, compact && selected && rect ? mobileMapTargetY(rect, top ?? rect.bottom) : (size.height - 48) / 2]
  }, [compact, selected, size])
  const centerRepo = useCallback((repo: AtlasRepo) => {
    const [x, y] = availableCenter()
    navigated.current = true
    apply(zoomIdentity.translate(x, y).scale(Math.max(fit.k * 2.2, targetTransformRef.current.k)).translate(-pointX(repo), -pointY(repo)), true)
  }, [apply, availableCenter, fit.k, pointX, pointY])

  useLayoutEffect(() => {
    const node = svgRef.current!
    const behavior = zoom<SVGSVGElement, unknown>()
      .extent((): [[number, number], [number, number]] => [[0, 0], [node.getBoundingClientRect().width, node.getBoundingClientRect().height]])
      .on('zoom', event => {
        if (programmaticTransform.current) {
          commitTransform(event.transform)
        } else {
          cancelCameraAnimation()
          targetTransformRef.current = event.transform
          navigated.current = true
          cancelClick()
          scheduleTransform()
        }
      })
    zoomRef.current = behavior
    configureZoom(behavior, viewportRef.current.fit)
    select(node).call(behavior).on('dblclick.zoom', null)
    writeTransform(viewportRef.current.transform)
    return () => {
      cancelCameraAnimation()
      select(node).on('.zoom', null)
      zoomRef.current = null
      cancelClick()
      if (frame.current != null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [cancelClick, cancelCameraAnimation, scheduleTransform, commitTransform, configureZoom, writeTransform])

  useLayoutEffect(() => {
    const node = svgRef.current!
    const resize = () => {
      const rect = node.getBoundingClientRect()
      svgOrigin.current = { left: rect.left, top: rect.top }
      tooltipOriginDirty.current = false
      if (rect.width <= 0 || rect.height <= 0) return
      const current = viewportRef.current
      const behavior = zoomRef.current!
      configureZoom(behavior, current.fit)
      const nextSize = current.size.width === rect.width && current.size.height === rect.height
        ? current.size : { width: rect.width, height: rect.height }
      const inputsChanged = current.layoutToken !== preparedLabels
      if (current.measured && nextSize === current.size && !inputsChanged) {
        positionVisibleTooltip()
        return
      }
      const nextFit = fitOverview(data, view.layoutAlt, nextSize, sizes.radius, measure, fontSize, preparedLabels)
      const projectionChanged = current.alt !== view.layoutAlt
      if (projectionChanged) {
        navigated.current = false
        cancelClick()
      }
      const camera = !current.measured || projectionChanged || !navigated.current
        ? nextFit
        : resizeTransform(targetTransformRef.current, current.size, nextSize, current.fit, nextFit)
      const nextTransform = constrainMapTransform(camera, nextSize, bounds)
      const nextViewport = {
        size: nextSize, fit: nextFit, transform: nextTransform, measured: true,
        alt: view.layoutAlt, layoutToken: preparedLabels,
      }
      cancelCameraAnimation()
      targetTransformRef.current = nextTransform
      viewportRef.current = nextViewport
      configureZoom(behavior, nextFit)
      setViewport(nextViewport)
      writeTransform(nextTransform)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    resize()
    return () => observer.disconnect()
  }, [data, view.layoutAlt, sizes, measure, fontSize, preparedLabels, bounds, cancelClick, cancelCameraAnimation, configureZoom, positionVisibleTooltip, writeTransform])

  useLayoutEffect(() => {
    const node = svgRef.current
    if (reduced && node && !sameTransform(zoomTransform(node), targetTransformRef.current)) apply(targetTransformRef.current)
  }, [reduced, apply])

  const centeredProjection = useRef(view.layoutAlt)
  useLayoutEffect(() => {
    if (!viewport.measured || centeredProjection.current === viewport.alt) return
    centeredProjection.current = viewport.alt
    if (selected && !navigationRequest) centerRepo(selected)
  }, [viewport.measured, viewport.alt, selected, navigationRequest, centerRepo])

  useLayoutEffect(() => {
    if (!navigationRequest || consumedRequest.current === navigationRequest.nonce) return
    if (navigationRequest.clickToken !== clickGesture.current?.token) cancelClick()
    if (!viewportReady) return
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
  }, [navigationRequest, viewportReady, data, reposByName, pointX, pointY, size, fit.k, apply, centerRepo, onNavigationHandled, cancelClick])

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
      if (next) {
        event.preventDefault()
        cancelClick()
        const focusedDot = document.activeElement
        const focusStartedOnDot = focusedDot instanceof SVGElement
          && focusedDot.classList.contains('repo-dot') && svgRef.current?.contains(focusedDot)
        onSelect(next)
        if (focusStartedOnDot) {
          dotLookup.nodes.get(next.full_name)?.focus({ preventScroll: true })
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [data.repos, visible, selected, onSelect, view.layoutAlt, cancelClick, dotLookup])

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
  const currentTransform = () => svgRef.current ? zoomTransform(svgRef.current) : viewportRef.current.transform
  const hitRepo = (clientX: number, clientY: number, camera: ZoomTransform) => {
    const point = pointerToMapPoint(clientX, clientY, svgRef.current!.getBoundingClientRect(), camera)
    return nearestRepoAtPoint(data.repos, visible, point.x, point.y, 22 * point.unitsPerPixel, view.layoutAlt, drawnRadius, selected?.full_name)
  }
  const changeZoom = (factor: number) => {
    cancelClick()
    const current = targetTransformRef.current
    const center = availableCenter()
    const point = current.invert(center)
    const k = Math.max(fit.k * .6, Math.min(fit.k * 10, current.k * factor))
    navigated.current = true
    apply(zoomIdentity.translate(...center).scale(k).translate(-point[0], -point[1]), true)
  }
  const zoomAtPointer = (clientX: number, clientY: number, current = targetTransformRef.current) => {
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
  const queueClick = (kind: 'repo' | 'region', target: AtlasRepo | string | null, camera = currentTransform()) => {
    cancelClick()
    const gesture: ClickGesture = { token: ++clickSequence.current, kind, target, selection: selected, camera, committed: false }
    gesture.timer = setTimeout(() => commitClick(gesture), 300)
    clickGesture.current = gesture
  }
  const selectImmediately = useCallback((repo: AtlasRepo | null) => { cancelClick(); onSelect(repo) }, [cancelClick, onSelect])
  const mapGeometry = useMemo(() => <>
    {paths.map(path => <path key={path.key} d={path.path} className={`contour outer ${activeRegion === path.id ? 'active' : ''}`} style={{ fill: colors.get(path.id), stroke: colors.get(path.id) }} />)}
    {selected?.neighbors.map(neighbor => reposByName.get(neighbor.full_name)).filter((repo): repo is AtlasRepo => Boolean(repo) && visible.has(repo!.full_name)).map(repo => <line key={repo.full_name} className="neighbor-line" x1={pointX(selected)} y1={pointY(selected)} x2={pointX(repo)} y2={pointY(repo)} />)}
    {data.repos.map(repo => <g key={repo.full_name} transform={`translate(${pointX(repo)} ${pointY(repo)})`}
      className={`repo-point ${repo === selected ? 'selected' : ''} ${repo.low_confidence ? 'low-confidence' : ''}`}
      opacity={visible.has(repo.full_name) ? 1 : .1} pointerEvents={visible.has(repo.full_name) ? 'auto' : 'none'}
      onPointerEnter={event => { setHover(repo); updateTooltipPointer(event.clientX, event.clientY, true) }}
      onPointerMove={event => updateTooltipPointer(event.clientX, event.clientY)} onPointerLeave={() => setHover(null)}
      onFocus={() => setFocused(repo)} onBlur={() => setFocused(null)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectImmediately(repo) } }}
      onClick={event => { if (event.detail === 0) { event.stopPropagation(); selectImmediately(repo) } }}>
      <circle className="focus-ring" aria-hidden="true" pointerEvents="none" r={drawnRadius(repo) + 3 / fit.k} />
      <circle ref={dotLookup.refs.get(repo.full_name)} className="repo-dot" role="button" tabIndex={visible.has(repo.full_name) ? 0 : -1} aria-label={`${repo.name}: ${repo.one_liner}`}
        data-full-name={repo.full_name}
        r={drawnRadius(repo)} fill={repo.low_confidence ? '#07131d' : languageColors.get(repo.primary_language_category)}
        stroke={repo.low_confidence ? languageColors.get(repo.primary_language_category) : '#06131d'} />
    </g>)}
  </>, [paths, activeRegion, colors, selected, reposByName, visible, pointX, pointY, data.repos, drawnRadius, fit.k, languageColors, selectImmediately, dotLookup, updateTooltipPointer])
  const mapTooltipAnchor = activeRepo && activeRepo !== hover ? (() => {
    const [x, y] = transform.apply([pointX(activeRepo), pointY(activeRepo)])
    const radius = drawnRadius(activeRepo) * transform.k
    return { x: x + radius, y: y - radius }
  })() : null
  const mapAnchorX = mapTooltipAnchor?.x ?? 0
  const mapAnchorY = mapTooltipAnchor?.y ?? 0
  const usesPointerAnchor = Boolean(activeRepo && activeRepo === hover)
  useLayoutEffect(() => {
    // This is semantic transition state: the previous ready tooltip must survive an unready viewport.
    if (viewportReady) {
      // oxlint-disable-next-line react/set-state-in-effect
      setLastReadyRepo(current => current === activeRepo ? current : activeRepo)
    }
  }, [viewportReady, activeRepo])
  const tooltipRepo = viewportReady ? activeRepo : lastReadyRepo
  useLayoutEffect(() => {
    if (!viewportReady) return
    tooltipUsesPointer.current = usesPointerAnchor
    tooltipMapAnchor.current = activeRepo && !usesPointerAnchor ? { x: mapAnchorX, y: mapAnchorY } : null
    positionVisibleTooltip()
  }, [viewportReady, activeRepo, usesPointerAnchor, mapAnchorX, mapAnchorY, size.width, size.height, positionVisibleTooltip])
  useEffect(() => {
    const handleScroll = () => {
      tooltipOriginDirty.current = true
      if (tooltipUsesPointer.current && tooltipRef.current) scheduleTooltipPosition()
    }
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [scheduleTooltipPosition])
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const node = tooltipRef.current
      if (!node) return
      const entry = entries[0]
      if (entry && entry.target !== node) return
      const borderBoxSize = entry?.borderBoxSize as unknown as ResizeObserverSize | readonly ResizeObserverSize[] | undefined
      const borderBox = borderBoxSize && 'inlineSize' in borderBoxSize ? borderBoxSize : borderBoxSize?.[0]
      const width = borderBox?.inlineSize ?? node.offsetWidth
      const height = borderBox?.blockSize ?? node.offsetHeight
      if (width <= 0 || height <= 0) return
      tooltipSize.current = { width, height }
      positionVisibleTooltip(node)
    })
    tooltipObserver.current = observer
    if (tooltipRef.current) observer.observe(tooltipRef.current)
    return () => {
      observer.disconnect()
      tooltipObserver.current = null
      if (tooltipFrame.current != null) cancelAnimationFrame(tooltipFrame.current)
      tooltipFrame.current = null
    }
  }, [positionVisibleTooltip])
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
        const camera = currentTransform()
        const repo = hitRepo(event.clientX, event.clientY, camera)
        if (start?.type === 'touch') selectImmediately(repo)
        else queueClick('repo', repo, camera)
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
        if (gesture?.kind === 'repo' && gesture.committed) onSelect(gesture.selection, { navigate: false, clickToken: gesture.token })
        zoomAtPointer(event.clientX, event.clientY, gesture?.kind === 'repo' ? gesture.camera : undefined)
      }}>
      <rect width={size.width} height={size.height} className="map-bg" />
      <g transform={transform.toString()} className="map-geometry">{mapGeometry}</g>
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
    <MapTooltip repo={tooltipRepo} setNode={setTooltipNode} />
  </div>
}
