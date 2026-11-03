import { zoomIdentity, type ZoomTransform } from 'd3-zoom'
import type { AtlasCluster, AtlasData, Point } from './types'

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
function outerRings(data: AtlasData, cluster: AtlasCluster, alt: boolean): Point[][] {
  if (!alt) return cluster.contours.outer
  return cluster.contours_alt?.outer ?? (data.schema_version === 2 ? cluster.contours.outer : [])
}
export function atlasBounds(data: AtlasData, alt: boolean): Box {
  return boundsOf([
    ...data.repos.map((r): Point => alt ? [r.x_alt, r.y_alt] : [r.x, r.y]),
    ...data.clusters.flatMap(c => outerRings(data, c, alt).flat()),
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
const mix = ([x, y]: Point, [nx, ny]: Point, t: number): Point => [x + (nx - x) * t, y + (ny - y) * t]
const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1])
const cross = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
const svgPoint = ([x, y]: Point) => `${x.toFixed(3)},${y.toFixed(3)}`

function territoryOutline(ring: Point[], members: Point[]) {
  const distinct = ring.slice(0, -1).filter((p, i) => i === 0 || distance(p, ring[i - 1]) > 0)
  const vertices = distinct.filter((p, i) => cross(distinct.at(i - 1)!, p, distinct[(i + 1) % distinct.length]) !== 0)
  const center: Point = [
    vertices.reduce((sum, p) => sum + p[0], 0) / vertices.length,
    vertices.reduce((sum, p) => sum + p[1], 0) / vertices.length,
  ]
  const edges = vertices.map((a, i) => {
    const b = vertices[(i + 1) % vertices.length]
    return { a, b, length: distance(a, b) }
  })
  const winding = Math.sign(edges.reduce((area, { a, b }) => area + cross(a, b, center), 0))
  const clearance = Math.min(...edges.map(({ a, b, length }) =>
    Math.min(...(members.length ? members : [center]).map(p => winding * cross(a, b, p) / length))))
  if (vertices.length < 3 || !(clearance > 0)) {
    return { path: `M${ring.map(svgPoint).join('L')}Z`, ring }
  }

  // Each control point moves less than half the member clearance. Corner
  // controls lie on the hull and side controls move toward its center.
  const maxInset = clearance / 2
  const trims = edges.map(({ a, b, length }) => {
    const t = Math.min(.25, maxInset / length)
    return { start: mix(a, b, t), end: mix(b, a, t) }
  })
  const start = trims.at(-1)!.end
  const commands = [`M${svgPoint(start)}`]
  const samples = [start]
  let current = start
  const cubic = (handle1: Point, handle2: Point, end: Point) => {
    commands.push(`C${svgPoint(handle1)} ${svgPoint(handle2)} ${svgPoint(end)}`)
    for (let i = 1; i <= 8; i++) {
      const t = i / 8
      const a = mix(current, handle1, t), b = mix(handle1, handle2, t), c = mix(handle2, end, t)
      samples.push(mix(mix(a, b, t), mix(b, c, t), t))
    }
    current = end
  }
  edges.forEach(({ a }, i) => {
    const { start: sideStart, end: sideEnd } = trims[i]
    // A rounded corner, expressed as a cubic, is tangent to both sides.
    cubic(mix(current, a, 2 / 3), mix(sideStart, a, 2 / 3), sideStart)

    // Two cubics meet at a bowed midpoint, with parallel tangents at the
    // midpoint and ends. All their controls stay inside the padded hull.
    const left = mix(sideStart, sideEnd, .34)
    const right = mix(sideStart, sideEnd, .66)
    const span = distance(sideStart, sideEnd)
    const inset = Math.min(maxInset, span * .09 * Math.min(1, span / clearance))
    const t = Math.min(.3, inset / Math.max(distance(left, center), distance(right, center)))
    const bowedLeft = mix(left, center, t), bowedRight = mix(right, center, t)
    cubic(mix(sideStart, sideEnd, .16), bowedLeft, mix(bowedLeft, bowedRight, .5))
    cubic(bowedRight, mix(sideStart, sideEnd, .84), sideEnd)
  })
  return { path: `${commands.join('')}Z`, ring: samples }
}

export function prepareMapOutlines(data: AtlasData, alt: boolean) {
  const territories = data.schema_version === 3 && !alt
  return new Map(data.clusters.map(cluster => [cluster.id, outerRings(data, cluster, alt).map(ring => {
    if (territories) {
      const members = data.repos.filter(repo => repo.cluster_id === cluster.id).map(({ x, y }): Point => [x, y])
      return territoryOutline(ring, members)
    }
    return { path: `M${smoothRing(ring).map(svgPoint).join('L')}Z`, ring }
  })]))
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
export class BoxGrid {
  private cells = new Map<string, Box[]>()
  private keys(box: Box, gap = 0) {
    const keys: string[] = []
    for (let y = Math.floor((box.top - gap) / 64); y <= Math.floor((box.bottom + gap) / 64); y++) {
      for (let x = Math.floor((box.left - gap) / 64); x <= Math.floor((box.right + gap) / 64); x++) keys.push(`${x},${y}`)
    }
    return keys
  }
  add(box: Box) {
    for (const key of this.keys(box)) {
      const cell = this.cells.get(key)
      if (cell) cell.push(box)
      else this.cells.set(key, [box])
    }
  }
  hits(box: Box, gap = 4) {
    return this.keys(box, gap).some(key => this.cells.get(key)?.some(other => overlaps(box, other, gap)))
  }
}

const OFFSETS = Array.from({ length: 17 * 17 }, (_, i) => {
  const dx = (i % 17) * 24 - 192, dy = Math.floor(i / 17) * 24 - 192
  return { dx, dy, distance: Math.hypot(dx, dy) }
}).sort((a, b) => a.distance - b.distance)
interface PreparedLabel {
  id: number
  lines: string[]
  width: number
  height: number
  anchor: { x: number; y: number }
  rings: Point[][]
}
const HULL_MEMBERSHIP = new WeakMap<PreparedLabel, { scale: number; values: (boolean | undefined)[] }>()
function cachedHullMembership(label: PreparedLabel, offsetIndex: number, scale: number) {
  let cached = HULL_MEMBERSHIP.get(label)
  if (!cached || cached.scale !== scale) {
    cached = { scale, values: [] }
    HULL_MEMBERSHIP.set(label, cached)
  }
  const existing = cached.values[offsetIndex]
  if (existing !== undefined) return existing
  const { dx, dy } = OFFSETS[offsetIndex]
  const point: Point = [label.anchor.x + dx / scale, label.anchor.y + dy / scale]
  const value = label.rings.some(ring => inside(point, ring))
  cached.values[offsetIndex] = value
  return value
}
export function prepareRegionLabels(data: AtlasData, alt: boolean, measure: (text: string) => number, fontSize: number,
  outlines = prepareMapOutlines(data, alt)): PreparedLabel[] {
  return data.clusters.toSorted((a, b) => a.id - b.id).map(cluster => {
    const lines = wrapLabel(cluster.label, measure)
    return { id: cluster.id, lines, width: Math.max(...lines.map(measure)) + 8,
      height: lines.length * (fontSize + 3) + 4,
      anchor: alt ? cluster.label_anchor_alt ?? cluster.label_anchor : cluster.label_anchor,
      rings: outlines.get(cluster.id)?.map(({ ring }) => ring) ?? [] }
  })
}
export function placeRegionLabels(data: AtlasData, alt: boolean, transform: ZoomTransform, size: Size,
  radius: (count: number | null) => number, measure: (text: string) => number, fontSize: number,
  prepared = prepareRegionLabels(data, alt, measure, fontSize)): Label[] {
  const placed: Label[] = []
  const dots = new BoxGrid(), labels = new BoxGrid()
  for (const repo of data.repos) {
    const [x, y] = transform.apply(alt ? [repo.x_alt, repo.y_alt] : [repo.x, repo.y])
    const r = radius(repo.file_count) + 3
    // Off-screen circles cannot collide with a candidate inside the label viewport.
    if (x + r < 11 || x - r > size.width - 11 || y + r < 15 || y - r > size.height - 73) continue
    dots.add({ left: x - r, right: x + r, top: y - r, bottom: y + r })
  }
  for (const preparedLabel of prepared) {
    const { id, lines, width: w, height: h, anchor } = preparedLabel
    const [ax, ay] = transform.apply([anchor.x, anchor.y])
    let best: Label | undefined, bestScore = Infinity
    for (let offsetIndex = 0; offsetIndex < OFFSETS.length; offsetIndex++) {
      const { dx, dy, distance } = OFFSETS[offsetIndex]
      if (distance >= bestScore) break
      const x = ax + dx, y = ay + dy
      const box = { id, x, y, lines, left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 }
      if (box.left < 12 || box.right > size.width - 12 || box.top < 16 || box.bottom > size.height - 74) continue
      if (labels.hits(box, 8) || dots.hits(box, 1)) continue
      const inHull = cachedHullMembership(preparedLabel, offsetIndex, transform.k)
      const score = distance + (inHull ? 0 : 48)
      if (score < bestScore) { best = box; bestScore = score }
    }
    if (best) { placed.push(best); labels.add(best) }
  }
  return placed
}

export function constrainMapTransform(transform: ZoomTransform, size: Size, bounds: Box): ZoomTransform {
  const marginX = Math.min(24, size.width / 2), marginY = Math.min(24, size.height / 2)
  const x = Math.max(marginX - bounds.right * transform.k, Math.min(size.width - marginX - bounds.left * transform.k, transform.x))
  const y = Math.max(marginY - bounds.bottom * transform.k, Math.min(size.height - marginY - bounds.top * transform.k, transform.y))
  return zoomIdentity.translate(x, y).scale(transform.k)
}

export function fitOverview(data: AtlasData, alt: boolean, size: Size, radius: (count: number | null) => number,
  measure: (text: string) => number, fontSize: number,
  prepared = prepareRegionLabels(data, alt, measure, fontSize)) {
  const bounds = atlasBounds(data, alt)
  const first = fitBounds(bounds, size, 44, 84)
  const labels = placeRegionLabels(data, alt, first, size, radius, measure, fontSize, prepared)
  // The first fit already reserves room for labels. Avoid shrinking complete
  // territories into a tighter configuration that can lose a placed label.
  if (data.layout === 'territories' && !alt && labels.length === prepared.length) return first
  const corners: Point[] = labels.flatMap(label => [first.invert([label.left, label.top]), first.invert([label.right, label.bottom])])
  return fitBounds(boundsOf([[bounds.left, bounds.top], [bounds.right, bounds.bottom], ...corners]), size, 44, 84)
}
