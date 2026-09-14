import { describe, expect, it } from 'vitest'
import { zoomIdentity, type ZoomTransform } from 'd3-zoom'
import { BoxGrid, fitBounds, fitOverview, overlaps, placeRegionLabels, prepareRegionLabels, resizeTransform, smoothRing, wrapLabel, type Label, type Size } from './map-geometry'
import { makeAtlas, makeRepo } from './test-fixtures'
import { pointerToMapPoint } from './view-utils'
import { fileSizeScale } from './presentation'
import fixture from './test-data/region-layout.json'
import type { AtlasData, Point } from './types'

const measure = (text: string) => text.length * 7
const exhaustiveOffsets = Array.from({ length: 17 * 17 }, (_, i) => {
  const dx = (i % 17) * 24 - 192
  const dy = Math.floor(i / 17) * 24 - 192
  return { dx, dy, distance: Math.hypot(dx, dy) }
})
function inside(point: Point, ring: Point[]) {
  let result = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) result = !result
  }
  return result
}
function exhaustivePlacement(
  data: AtlasData,
  alt: boolean,
  transform: ZoomTransform,
  size: Size,
  radius: (count: number | null) => number,
  fontSize: number,
  prepared = prepareRegionLabels(data, alt, measure, fontSize),
) {
  const placed: Label[] = []
  const dots = new BoxGrid()
  const labels = new BoxGrid()
  for (const repo of data.repos) {
    const [x, y] = transform.apply(alt ? [repo.x_alt, repo.y_alt] : [repo.x, repo.y])
    const r = radius(repo.file_count) + 3
    if (x + r < 11 || x - r > size.width - 11 || y + r < 15 || y - r > size.height - 73) continue
    dots.add({ left: x - r, right: x + r, top: y - r, bottom: y + r })
  }
  for (const item of prepared) {
    const [ax, ay] = transform.apply([item.anchor.x, item.anchor.y])
    let best: Label | undefined
    let bestScore = Infinity
    for (const { dx, dy, distance } of exhaustiveOffsets) {
      const x = ax + dx
      const y = ay + dy
      const box = {
        id: item.id,
        x,
        y,
        lines: item.lines,
        left: x - item.width / 2,
        right: x + item.width / 2,
        top: y - item.height / 2,
        bottom: y + item.height / 2,
      }
      if (box.left < 12 || box.right > size.width - 12 || box.top < 16 || box.bottom > size.height - 74) continue
      if (labels.hits(box, 8) || dots.hits(box, 1)) continue
      const point: Point = [item.anchor.x + dx / transform.k, item.anchor.y + dy / transform.k]
      const score = distance + (item.rings.some(ring => inside(point, ring)) ? 0 : 48)
      if (score < bestScore) {
        best = box
        bestScore = score
      }
    }
    if (best) {
      placed.push(best)
      labels.add(best)
    }
  }
  return placed
}

describe('map geometry', () => {
  it('fits a wide dataset inside a rectangular viewport with HUD clearance', () => {
    const box = { left: -20, right: 1500, top: 100, bottom: 950 }
    const size = { width: 944, height: 574 }
    const fit = fitBounds(box, size)
    expect(fit.applyX(box.left)).toBeGreaterThanOrEqual(32 - 1e-9)
    expect(fit.applyX(box.right)).toBeLessThanOrEqual(size.width - 32)
    expect(fit.applyY(box.top)).toBeGreaterThanOrEqual(32 - 1e-9)
    expect(fit.applyY(box.bottom)).toBeLessThanOrEqual(size.height - 72 + 1e-9)
  })
  it('inverts pointer coordinates in a non-square map after pan and zoom', () => {
    const transform = zoomIdentity.translate(80, -20).scale(.75)
    const [x, y] = transform.apply([210, 610])
    const point = pointerToMapPoint(x + 30, y + 100, { left: 30, top: 100, width: 944, height: 574 }, transform)
    expect(point.x).toBeCloseTo(210)
    expect(point.y).toBeCloseTo(610)
    expect(point.unitsPerPixel).toBeCloseTo(1 / .75)
  })
  it('preserves the viewed world center and relative zoom on resize', () => {
    const oldSize = { width: 944, height: 574 }, size = { width: 704, height: 600 }
    const oldFit = zoomIdentity.scale(.5), fit = zoomIdentity.scale(.4)
    const current = zoomIdentity.translate(200, 40).scale(1.5)
    const result = resizeTransform(current, oldSize, size, oldFit, fit)
    expect(result.invert([size.width / 2, size.height / 2])).toEqual(current.invert([oldSize.width / 2, oldSize.height / 2]))
    expect(result.k / fit.k).toBeCloseTo(current.k / oldFit.k)
  })
  it('wraps long labels into two balanced lines and smooths without mutating rings', () => {
    expect(wrapLabel('Typed Systems Integration', measure)).toEqual(['Typed Systems', 'Integration'])
    const ring: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]
    const result = smoothRing(ring)
    expect(result).toHaveLength(8)
    expect(ring).toHaveLength(5)
    expect(result[0]).toEqual([25, 0])
  })
  it('places labels without covering points or each other, deterministically', () => {
    const data = makeAtlas([makeRepo()])
    data.clusters.push({ ...data.clusters[0], id: 1, label: 'Another Region' })
    const layout = () => placeRegionLabels(data, false, zoomIdentity, { width: 1000, height: 700 }, () => 9, measure, 13)
    const labels = layout()
    expect(labels).toHaveLength(2)
    expect(overlaps(labels[0], labels[1])).toBe(false)
    expect(labels.every(label => !overlaps(label, { left: 491, right: 509, top: 491, bottom: 509 }))).toBe(true)
    expect(layout()).toEqual(labels)
  })
  it.each([[1120, 766], [944, 578], [704, 584]])('fits all ten fixed-fixture region labels in a %sx%s desktop map', (width, height) => {
    const data = { ...makeAtlas(fixture.repos.map((repo, i) => makeRepo({ ...repo, full_name: `fixture/${i}` }))), clusters: fixture.clusters as AtlasData['clusters'] }, size = { width, height }, scale = fileSizeScale(data.repos)
    const fit = fitOverview(data, false, size, scale.radius, measure, 13)
    const labels = placeRegionLabels(data, false, fit, size, scale.radius, measure, 13)
    expect(labels).toHaveLength(10)
    labels.forEach((label, i) => {
      expect(label.left).toBeGreaterThanOrEqual(12)
      expect(label.right).toBeLessThanOrEqual(width - 12)
      expect(label.bottom).toBeLessThanOrEqual(height - 74)
      expect(labels.slice(i + 1).some(other => overlaps(label, other))).toBe(false)
    })
  })
  it.each([[1120, 766], [944, 578], [704, 584]])('matches exhaustive placement across transforms in a %sx%s map', (width, height) => {
    const data = { ...makeAtlas(fixture.repos.map((repo, i) => makeRepo({ ...repo, full_name: `fixture/${i}` }))), clusters: fixture.clusters as AtlasData['clusters'] }
    const size = { width, height }
    const scale = fileSizeScale(data.repos)
    const prepared = prepareRegionLabels(data, false, measure, 13)
    const fit = fitOverview(data, false, size, scale.radius, measure, 13, prepared)
    const transforms = [
      fit,
      zoomIdentity.translate(fit.x + 31, fit.y - 17).scale(fit.k),
      zoomIdentity.translate(width / 2 + 20, height / 2 - 10).scale(fit.k * 1.8).translate(-500, -500),
    ]
    for (const transform of transforms) {
      const radius = (count: number | null) => scale.radius(count) * transform.k / fit.k
      expect(placeRegionLabels(data, false, transform, size, radius, measure, 13, prepared))
        .toEqual(exhaustivePlacement(data, false, transform, size, radius, 13, prepared))
    }
  })
})

it.each([[1000, 700], [390, 668], [20, 10]])('constrains extreme transforms inside a %sx%s viewport', async (width, height) => {
  const { constrainMapTransform } = await import('./map-geometry')
  const bounds = { left: -100, right: 900, top: 50, bottom: 800 }
  for (const k of [.01, .5, 10]) for (const position of [-1e6, 1e6]) {
    const next = constrainMapTransform(zoomIdentity.translate(position, -position).scale(k), { width, height }, bounds)
    expect(next.applyX(bounds.right)).toBeGreaterThanOrEqual(Math.min(24, width / 2) - 1e-8)
    expect(next.applyX(bounds.left)).toBeLessThanOrEqual(width - Math.min(24, width / 2) + 1e-8)
    expect(next.applyY(bounds.bottom)).toBeGreaterThanOrEqual(Math.min(24, height / 2) - 1e-8)
    expect(next.applyY(bounds.top)).toBeLessThanOrEqual(height - Math.min(24, height / 2) + 1e-8)
    expect(next.k).toBe(k)
  }
})

it('finds collisions across spatial-grid boundaries with the requested padding', async () => {
  const { BoxGrid } = await import('./map-geometry')
  const grid = new BoxGrid()
  grid.add({ left: 60, right: 63, top: 60, bottom: 63 })
  expect(grid.hits({ left: 65, right: 70, top: 65, bottom: 70 }, 4)).toBe(true)
  expect(grid.hits({ left: 65, right: 70, top: 65, bottom: 70 }, 1)).toBe(false)
  expect(grid.hits({ left: -200, right: -100, top: -200, bottom: -100 })).toBe(false)
})
