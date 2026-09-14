import { describe, expect, it } from 'vitest'
import { zoomIdentity } from 'd3-zoom'
import { fitBounds, fitOverview, overlaps, placeRegionLabels, resizeTransform, smoothRing, wrapLabel } from './map-geometry'
import { makeAtlas, makeRepo } from './test-fixtures'
import { pointerToMapPoint } from './view-utils'
import { fileSizeScale } from './presentation'
import fixture from './test-data/region-layout.json'
import type { AtlasData } from './types'

const measure = (text: string) => text.length * 7

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
