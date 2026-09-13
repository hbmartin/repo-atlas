import { useEffect, useState } from 'react'
import type { AtlasRepo } from './types'

export function formatDate(value: string) {
  const normalized = /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${normalized}T00:00:00Z`))
}

export function pointerToMapPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  transform: { x: number; y: number; k: number },
) {
  const scale = Math.min(bounds.width, bounds.height) / 1000
  const offsetX = (bounds.width - 1000 * scale) / 2
  return {
    x: ((clientX - bounds.left - offsetX) / scale - transform.x) / transform.k,
    y: ((clientY - bounds.top) / scale - transform.y) / transform.k,
    unitsPerPixel: 1 / scale / transform.k,
  }
}

export function mobileMapTargetY(
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  occlusionTop: number,
) {
  const scale = Math.min(bounds.width, bounds.height) / 1000
  if (!Number.isFinite(scale) || scale <= 0) return 210
  const contentTop = bounds.top
  const contentBottom = contentTop + 1000 * scale
  const visibleBottom = Math.min(contentBottom, occlusionTop)
  const visibleHeight = Math.max(0, visibleBottom - contentTop)
  return Math.max(30, Math.min(500, visibleHeight / (2 * scale)))
}

export function nearestRepoInDirection(
  repos: AtlasRepo[],
  visible: Set<string>,
  selected: AtlasRepo,
  directionX: number,
  directionY: number,
  layoutAlt: boolean,
) {
  const selectedX = layoutAlt ? selected.x_alt : selected.x
  const selectedY = layoutAlt ? selected.y_alt : selected.y
  let nearest: AtlasRepo | null = null
  let nearestSquared = Number.POSITIVE_INFINITY
  for (const repo of repos) {
    if (repo.full_name === selected.full_name || !visible.has(repo.full_name)) continue
    const dx = (layoutAlt ? repo.x_alt : repo.x) - selectedX
    const dy = (layoutAlt ? repo.y_alt : repo.y) - selectedY
    if (dx * directionX + dy * directionY <= 0) continue
    const squared = dx * dx + dy * dy
    if (
      squared < nearestSquared
      || (squared === nearestSquared && nearest && repo.full_name.localeCompare(nearest.full_name) < 0)
    ) {
      nearest = repo
      nearestSquared = squared
    }
  }
  return nearest
}

export function nearestRepoAtPoint(
  repos: AtlasRepo[],
  visible: Set<string>,
  x: number,
  y: number,
  maxDistance: number,
  layoutAlt: boolean,
) {
  let nearest: AtlasRepo | null = null
  let nearestSquared = maxDistance * maxDistance
  for (const repo of repos) {
    if (!visible.has(repo.full_name)) continue
    const dx = (layoutAlt ? repo.x_alt : repo.x) - x
    const dy = (layoutAlt ? repo.y_alt : repo.y) - y
    const squared = dx * dx + dy * dy
    if (squared <= nearestSquared) {
      nearest = repo
      nearestSquared = squared
    }
  }
  return nearest
}

export function clusterLabelX(
  anchorX: number,
  label: string,
  gloss: string,
  showGloss: boolean,
) {
  const estimatedWidth = Math.min(
    960,
    Math.max(label.length * 9, showGloss ? gloss.length * 5.5 : 0),
  )
  const halfWidth = estimatedWidth / 2
  return Math.max(halfWidth + 10, Math.min(990 - halfWidth, anchorX))
}

export function toggleValue(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value]
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}
