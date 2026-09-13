import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { select } from 'd3-selection'
import 'd3-transition'
import {
  zoom,
  zoomIdentity,
  type ZoomBehavior,
  type ZoomTransform,
} from 'd3-zoom'
import type { AtlasData, AtlasRepo, ViewState } from '../types'
import {
  clusterLabelX,
  formatDate,
  mobileMapTargetY,
  nearestRepoAtPoint,
  nearestRepoInDirection,
  pointerToMapPoint,
  useReducedMotion,
} from '../view-utils'

function ringPath(ring: [number, number][]) {
  return ring.length ? `M${ring.map(([x, y]) => `${x},${y}`).join('L')}Z` : ''
}

export function MapView({
  data,
  view,
  visible,
  selected,
  onSelect,
}: {
  data: AtlasData
  view: ViewState
  visible: Set<string>
  selected: AtlasRepo | null
  onSelect: (repo: AtlasRepo | null) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity)
  const [hover, setHover] = useState<AtlasRepo | null>(null)
  const [tooltip, setTooltip] = useState({ x: 0, y: 0 })
  const [svgSize, setSvgSize] = useState(1000)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const reduced = useReducedMotion()
  const reposByName = useMemo(
    () => new Map(data.repos.map((repo) => [repo.full_name, repo])),
    [data.repos],
  )
  const pointX = useCallback(
    (repo: AtlasRepo) => (view.layoutAlt ? repo.x_alt : repo.x),
    [view.layoutAlt],
  )
  const pointY = useCallback(
    (repo: AtlasRepo) => (view.layoutAlt ? repo.y_alt : repo.y),
    [view.layoutAlt],
  )

  useEffect(() => {
    if (!svgRef.current) return
    const node = svgRef.current
    const resize = new ResizeObserver(() => {
      setSvgSize(Math.max(1, Math.min(node.clientWidth, node.clientHeight)))
    })
    resize.observe(node)
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.6, 10])
      .translateExtent([
        [-700, -700],
        [1700, 1700],
      ])
      .on('zoom', (event) => setTransform(event.transform))
    zoomRef.current = behavior
    select(node).call(behavior).on('dblclick.zoom', null)
    return () => {
      resize.disconnect()
      select(node).on('.zoom', null)
    }
  }, [])

  const centerRepo = useCallback(
    (repo: AtlasRepo, scale = 2.2) => {
      if (!svgRef.current || !zoomRef.current) return
      const bounds = svgRef.current.getBoundingClientRect()
      const panelTop = document.querySelector<HTMLElement>('.detail-panel.populated')
        ?.getBoundingClientRect().top
      const targetY = window.matchMedia('(max-width: 1023px)').matches
        ? mobileMapTargetY(bounds, panelTop ?? bounds.top + bounds.height * 0.4)
        : 500
      const next = zoomIdentity
        .translate(500, targetY)
        .scale(scale)
        .translate(-pointX(repo), -pointY(repo))
      const selection = select(svgRef.current)
      if (reduced) selection.call(zoomRef.current.transform, next)
      else selection.transition().duration(400).call(zoomRef.current.transform, next)
    },
    [pointX, pointY, reduced],
  )

  useEffect(() => {
    if (selected) centerRepo(selected)
  }, [selected, view.layoutAlt, centerRepo])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selected || event.defaultPrevented || svgRef.current?.closest('[inert]')) return
      const target = event.target
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.matches('input, textarea, select')
      )) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onSelect(null)
        return
      }
      const direction = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[event.key]
      if (!direction) return
      const next = nearestRepoInDirection(
        data.repos,
        visible,
        selected,
        direction[0],
        direction[1],
        view.layoutAlt,
      )
      if (next) {
        event.preventDefault()
        onSelect(next)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [data.repos, onSelect, selected, view.layoutAlt, visible])

  const neighbors = selected?.neighbors
    .map((neighbor) => reposByName.get(neighbor.full_name))
    .filter((repo): repo is AtlasRepo => Boolean(repo))
  const labelOpacity = transform.k < 1.5
    ? 1
    : transform.k > 2.5
      ? 0.15
      : Math.max(0.15, 1 - (transform.k - 1.5) / 1.2)
  const repoLabelOpacity = transform.k < 1.5 ? 0 : transform.k > 2.5 ? 1 : transform.k - 1.5
  const orderedRepos = useMemo(
    () => data.repos.toSorted(
      (a, b) => (a.cluster_id ?? 9999) - (b.cluster_id ?? 9999) || a.name.localeCompare(b.name),
    ),
    [data.repos],
  )
  const placedLabels = useMemo(() => {
    if (transform.k < 1.5) return new Set<string>()
    const placed: { left: number; right: number; top: number; bottom: number }[] = []
    const names = new Set<string>()
    const candidates = data.repos
      .filter((repo) => visible.has(repo.full_name))
      .toSorted((a, b) => b.size_r - a.size_r || a.name.localeCompare(b.name))
    for (const repo of candidates) {
      const x = pointX(repo) * transform.k + transform.x + (repo.size_r + 7) * transform.k
      const y = pointY(repo) * transform.k + transform.y
      const box = {
        left: x,
        right: x + Math.max(34, repo.name.length * 7) * transform.k,
        top: y - 10 * transform.k,
        bottom: y + 7 * transform.k,
      }
      if (placed.some((other) => !(
        box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom
      ))) continue
      names.add(repo.full_name)
      placed.push(box)
    }
    return names
  }, [data.repos, pointX, pointY, transform, visible])
  const showClusterGlosses = transform.k < 1.5 && svgSize >= 1150

  return (
    <div className="map-shell">
      <svg
        ref={svgRef}
        className="atlas-map"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMin meet"
        role="group"
        aria-label="Semantic map of public GitHub repositories"
        onPointerDown={(event) => {
          pointerStart.current = { x: event.clientX, y: event.clientY }
        }}
        onPointerCancel={() => { pointerStart.current = null }}
        onClick={(event) => {
          if (event.detail === 0) return
          const start = pointerStart.current
          pointerStart.current = null
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
          const point = pointerToMapPoint(
            event.clientX,
            event.clientY,
            event.currentTarget.getBoundingClientRect(),
            transform,
          )
          onSelect(nearestRepoAtPoint(
            data.repos,
            visible,
            point.x,
            point.y,
            22 * point.unitsPerPixel,
            view.layoutAlt,
          ))
        }}
        onDoubleClick={(event) => {
          const point = pointerToMapPoint(
            event.clientX,
            event.clientY,
            event.currentTarget.getBoundingClientRect(),
            transform,
          )
          const repo = nearestRepoAtPoint(
            data.repos, visible, point.x, point.y, 22 * point.unitsPerPixel, view.layoutAlt,
          )
          if (repo) centerRepo(repo, 2.6)
        }}
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="currentColor" strokeWidth=".7" />
          </pattern>
          <filter id="glow">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width="1000" height="1000" className="map-bg" />
        <rect width="1000" height="1000" fill="url(#grid)" className="map-grid" />
        <g transform={transform.toString()}>
          {data.clusters.flatMap((cluster) => (
            view.layoutAlt ? (cluster.contours_alt ?? cluster.contours) : cluster.contours
          ).outer.map((ring, index) => (
            <path key={`o-${cluster.id}-${index}`} d={ringPath(ring)} className="contour outer" />
          )))}
          {data.clusters.flatMap((cluster) => (
            view.layoutAlt ? (cluster.contours_alt ?? cluster.contours) : cluster.contours
          ).inner.map((ring, index) => (
            <path key={`i-${cluster.id}-${index}`} d={ringPath(ring)} className="contour inner" />
          )))}
          {selected && neighbors?.filter((repo) => visible.has(repo.full_name)).map((repo) => (
            <line
              key={repo.full_name}
              className="neighbor-line"
              x1={pointX(selected)}
              y1={pointY(selected)}
              x2={pointX(repo)}
              y2={pointY(repo)}
            />
          ))}
          {orderedRepos.map((repo) => {
            const language = data.languages.find((item) => item.name === repo.primary_language)
            const isVisible = visible.has(repo.full_name)
            const isSelected = selected?.full_name === repo.full_name
            const isHover = hover?.full_name === repo.full_name
            const radius = repo.size_r * (isSelected || isHover ? 1.3 : 1)
            const showLabel = isSelected || isHover || placedLabels.has(repo.full_name)
            return (
              <g
                key={repo.full_name}
                transform={`translate(${pointX(repo)} ${pointY(repo)})`}
                className={`repo-point ${isSelected ? 'selected' : ''} ${repo.low_confidence ? 'low-confidence' : ''}`}
                opacity={isVisible ? 1 : 0.1}
                pointerEvents={isVisible ? 'auto' : 'none'}
                onPointerEnter={(event) => {
                  setHover(repo)
                  setTooltip({ x: event.clientX, y: event.clientY })
                }}
                onPointerMove={(event) => setTooltip({ x: event.clientX, y: event.clientY })}
                onPointerLeave={() => setHover(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(repo)
                  }
                }}
                onClick={(event) => {
                  if (event.detail === 0) {
                    event.stopPropagation()
                    onSelect(repo)
                  }
                }}
              >
                <circle
                  role="button"
                  tabIndex={isVisible ? 0 : -1}
                  aria-label={`${repo.name}: ${repo.one_liner}`}
                  r={radius}
                  fill={repo.low_confidence ? '#08131d' : (language?.color ?? '#87909e')}
                  stroke={language?.color ?? '#87909e'}
                />
                {showLabel && (
                  <text
                    className="repo-label"
                    x={radius + 7}
                    y="4"
                    opacity={isSelected || isHover ? 1 : repoLabelOpacity}
                  >
                    {repo.name}
                  </text>
                )}
              </g>
            )
          })}
          {data.clusters.map((cluster) => {
            const anchor = view.layoutAlt
              ? (cluster.label_anchor_alt ?? cluster.label_anchor)
              : cluster.label_anchor
            const anchorX = clusterLabelX(
              anchor.x,
              cluster.label,
              cluster.gloss,
              showClusterGlosses,
            )
            return (
              <g
                key={cluster.id}
                className="cluster-label"
                transform={`translate(${anchorX} ${anchor.y})`}
                style={{ opacity: labelOpacity }}
              >
                <text>{cluster.label}</text>
                {showClusterGlosses && <text y="23" className="cluster-gloss">{cluster.gloss}</text>}
              </g>
            )
          })}
        </g>
      </svg>
      <div className="map-hud">
        <span>{Math.round(transform.k * 100)}%</span>
        <button
          onClick={() => svgRef.current && zoomRef.current && select(svgRef.current)
            .transition()
            .duration(reduced ? 0 : 300)
            .call(zoomRef.current.transform, zoomIdentity)}
        >
          Reset view
        </button>
      </div>
      {hover && (
        <div
          className="tooltip"
          style={{
            left: Math.min(tooltip.x + 14, window.innerWidth - 284),
            top: Math.min(tooltip.y + 14, window.innerHeight - 110),
          }}
        >
          <strong>{hover.name}</strong>
          <span>{hover.one_liner}</span>
          <small>{hover.primary_language} · updated {formatDate(hover.pushed_at)}</small>
        </div>
      )}
    </div>
  )
}
