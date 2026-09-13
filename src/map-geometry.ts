import { zoomIdentity, type ZoomTransform } from 'd3-zoom'
import type { AtlasData, Point } from './types'

export interface Size { width: number; height: number }
export interface Box { left: number; top: number; right: number; bottom: number }
export interface Label extends Box { id: number; x: number; y: number; lines: string[] }
export const overlaps = (a: Box, b: Box, gap = 4) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top
export function boundsOf(points: Point[]): Box {
  if (!points.length) return { left: 0, top: 0, right: 1000, bottom: 1000 }
  return { left: Math.min(...points.map(p => p[0])), right: Math.max(...points.map(p => p[0])), top: Math.min(...points.map(p => p[1])), bottom: Math.max(...points.map(p => p[1])) }
}
export function fitBounds(box: Box, size: Size, padding = 32, bottom = 72): ZoomTransform {
  const width = Math.max(1, size.width - padding * 2)
  const height = Math.max(1, size.height - padding - bottom)
  const k = Math.max(.001, Math.min(width / Math.max(1, box.right - box.left), height / Math.max(1, box.bottom - box.top)))
  return zoomIdentity.translate(padding + width / 2, padding + height / 2).scale(k)
    .translate(-(box.left + box.right) / 2, -(box.top + box.bottom) / 2)
}
export function resizeTransform(current: ZoomTransform, oldSize: Size, size: Size, oldFit: ZoomTransform, fit: ZoomTransform) {
  const center = current.invert([oldSize.width / 2, oldSize.height / 2])
  return zoomIdentity.translate(size.width / 2, size.height / 2).scale(current.k / oldFit.k * fit.k).translate(-center[0], -center[1])
}
export function atlasBounds(data: AtlasData, alt: boolean): Box {
  return boundsOf([
    ...data.repos.map((r): Point => alt ? [r.x_alt, r.y_alt] : [r.x, r.y]),
    ...data.clusters.flatMap(c => (alt ? c.contours_alt ?? c.contours : c.contours).outer.flat()),
  ])
}
export function smoothRing(ring: Point[]): Point[] {
  if (ring.length < 3) return ring
  const vertices = ring.length > 3 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring
  return vertices.flatMap(([x, y], i): Point[] => {
    const [nx, ny] = vertices[(i + 1) % vertices.length]
    return [[.75 * x + .25 * nx, .75 * y + .25 * ny], [.25 * x + .75 * nx, .25 * y + .75 * ny]]
  })
}
function inside(point: Point, ring: Point[]) {
  let result = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) result = !result
  }
  return result
}
export function wrapLabel(text: string, measure: (text: string) => number, maxWidth = 155) {
  if (measure(text) <= maxWidth) return [text]
  const words = text.split(' ')
  let best = [text], score = Infinity
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')]
    const width = Math.max(...pair.map(measure))
    if (width < score) { best = pair; score = width }
  }
  return best
}
// All collision tests use CSS pixels. Geometry and anchors stay in the dataset's space.
export function placeRegionLabels(data: AtlasData, alt: boolean, transform: ZoomTransform, size: Size,
  radius: (count: number | null) => number, measure: (text: string) => number, fontSize: number): Label[] {
  const placed: Label[] = []
  const dots = data.repos.map(repo => {
    const [x, y] = transform.apply(alt ? [repo.x_alt, repo.y_alt] : [repo.x, repo.y])
    const r = radius(repo.file_count) + 3
    return { left: x - r, right: x + r, top: y - r, bottom: y + r }
  })
  for (const cluster of data.clusters.toSorted((a, b) => a.id - b.id)) {
    const anchor = alt ? cluster.label_anchor_alt ?? cluster.label_anchor : cluster.label_anchor
    const [ax, ay] = transform.apply([anchor.x, anchor.y])
    const rings = (alt ? cluster.contours_alt ?? cluster.contours : cluster.contours).outer
    const lines = wrapLabel(cluster.label, measure)
    const w = Math.max(...lines.map(measure)) + 8, h = lines.length * (fontSize + 3) + 4
    const candidates: { box: Label; score: number }[] = []
    for (let dy = -192; dy <= 192; dy += 24) for (let dx = -192; dx <= 192; dx += 24) {
      const x = ax + dx, y = ay + dy
      const box = { id: cluster.id, x, y, lines, left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 }
      if (box.left < 12 || box.right > size.width - 12 || box.top < 16 || box.bottom > size.height - 74) continue
      if (placed.some(other => overlaps(box, other, 8))) continue
      const hits = dots.filter(dot => overlaps(box, dot, 1)).length
      const inHull = rings.some(ring => inside(transform.invert([x, y]), ring))
      candidates.push({ box, score: hits * 1e6 + Math.hypot(dx, dy) + (inHull ? 0 : 48) })
    }
    candidates.sort((a, b) => a.score - b.score)
    const best = candidates[0]
    if (best && best.score < 1e6) placed.push(best.box)
  }
  return placed
}
export function fitOverview(data: AtlasData, alt: boolean, size: Size, radius: (count: number | null) => number,
  measure: (text: string) => number, fontSize: number) {
  const bounds = atlasBounds(data, alt)
  const first = fitBounds(bounds, size, 44, 84)
  const labels = placeRegionLabels(data, alt, first, size, radius, measure, fontSize)
  const corners: Point[] = labels.flatMap(label => [first.invert([label.left, label.top]), first.invert([label.right, label.bottom])])
  return fitBounds(boundsOf([[bounds.left, bounds.top], [bounds.right, bounds.bottom], ...corners]), size, 44, 84)
}
