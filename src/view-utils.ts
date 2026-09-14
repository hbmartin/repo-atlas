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
  return {
    x: (clientX - bounds.left - transform.x) / transform.k,
    y: (clientY - bounds.top - transform.y) / transform.k,
    unitsPerPixel: 1 / transform.k,
  }
}

export function mobileMapTargetY(
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  occlusionTop: number,
) {
  return Math.max(24, Math.min(bounds.height, occlusionTop - bounds.top) / 2)
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
  drawnRadius: (repo: AtlasRepo) => number = () => 0,
  preferredFullName: string | null = null,
) {
  let nearest: AtlasRepo | null = null
  let nearestSquared = Number.POSITIVE_INFINITY
  let nearestEdgeDistance = Number.POSITIVE_INFINITY
  for (const repo of repos) {
    if (!visible.has(repo.full_name)) continue
    const dx = (layoutAlt ? repo.x_alt : repo.x) - x
    const dy = (layoutAlt ? repo.y_alt : repo.y) - y
    const squared = dx * dx + dy * dy
    const radius = drawnRadius(repo)
    const hitRadius = Math.max(maxDistance, radius)
    if (squared > hitRadius * hitRadius) continue
    // Actual circle hits precede padded targets. Within overlapping circles,
    // prefer the nearest center, then use a stable selection/name tie-break.
    const edgeDistance = Math.max(0, Math.sqrt(squared) - radius)
    const winsTie = edgeDistance === nearestEdgeDistance && squared === nearestSquared && (
      repo.full_name === preferredFullName
      || (nearest?.full_name !== preferredFullName && (
        !nearest || repo.full_name.localeCompare(nearest.full_name) < 0
      ))
    )
    if (edgeDistance < nearestEdgeDistance
      || (edgeDistance === nearestEdgeDistance && squared < nearestSquared) || winsTie) {
      nearest = repo
      nearestSquared = squared
      nearestEdgeDistance = edgeDistance
    }
  }
  return nearest
}

export function toggleValue(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value]
}

export const COMPACT_MEDIA_QUERY = '(max-width: 1023px)'
export const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)'
export const MAP_TRANSITION_DURATION = 250

export function useMediaQuery(queryText: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(queryText).matches)
  useEffect(() => {
    const query = window.matchMedia(queryText)
    const update = () => setMatches(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [queryText])
  return matches
}

export function useReducedMotion() {
  return useMediaQuery(REDUCED_MOTION_MEDIA_QUERY)
}
