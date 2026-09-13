import { describe, expect, it } from 'vitest'
import { zoomIdentity } from 'd3-zoom'
import { fitBounds, fitOverview, overlaps, placeRegionLabels, resizeTransform, smoothRing, wrapLabel } from './map-geometry'
import { makeAtlas, makeRepo } from './test-fixtures'
import { pointerToMapPoint } from './view-utils'
import { fileSizeScale } from './presentation'
import atlas from '../public/atlas.json'
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
  it.each([[1120, 766], [944, 578], [704, 584]])('fits all ten real region labels in a %sx%s desktop map', (width, height) => {
    const data = atlas as AtlasData, size = { width, height }, scale = fileSizeScale(data.repos)
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
