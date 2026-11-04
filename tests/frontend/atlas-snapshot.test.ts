import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { validateAtlas } from '../../src/data'
import { boundsOf, fitOverview, overlaps, placeRegionLabels, prepareMapOutlines, type Box } from '../../src/map-geometry'
import { fileSizeScale } from '../../src/presentation'

it('validates the committed deployable atlas before build', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../public/atlas.json', import.meta.url), 'utf8'))
  const atlas = validateAtlas(snapshot)
  expect(atlas.schema_version).toBe(3)
  expect(atlas.layout).toBe('territories')
  expect(snapshot.languages).toHaveLength(10)
  const semantic = prepareMapOutlines(atlas, true)
  expect([...semantic.values()].flat().length).toBeGreaterThan(0)
  const territories = prepareMapOutlines(atlas, false)
  const territoryBounds: Box[] = []
  for (const cluster of atlas.clusters) {
    expect(cluster.contours_alt).toEqual({ outer: [], inner: [] })
    if (cluster.member_count < 3) expect(semantic.get(cluster.id)).toHaveLength(0)
    const outlines = territories.get(cluster.id)!
    expect(outlines).toHaveLength(1)
    const [{ path, ring }] = outlines
    expect(path).toMatch(/^M[^CL]+C[^L]+Z$/)
    for (const { x, y } of atlas.repos.filter(repo => repo.cluster_id === cluster.id)) {
      const crossings = ring.slice(1).filter(([bx, by], i) => {
        const [ax, ay] = ring[i]
        return (ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)
      })
      expect(crossings.length % 2, `repo at (${x}, ${y}) inside ${cluster.label}`).toBe(1)
    }
    const bounds = boundsOf(ring)
    expect(territoryBounds.some(other => overlaps(other, bounds, 0))).toBe(false)
    territoryBounds.push(bounds)
  }
  const size = { width: 959, height: 586 }
  const measure = (text: string) => text.length * 7
  const { radius } = fileSizeScale(atlas.repos)
  const fit = fitOverview(atlas, false, size, radius, measure, 13)
  expect(placeRegionLabels(atlas, false, fit, size, radius, measure, 13)).toHaveLength(atlas.clusters.length)
})
