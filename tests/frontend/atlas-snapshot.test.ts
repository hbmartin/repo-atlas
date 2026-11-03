import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { validateAtlas } from '../../src/data'
import { fitOverview, placeRegionLabels } from '../../src/map-geometry'
import { fileSizeScale } from '../../src/presentation'

it('validates the committed deployable atlas before build', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../public/atlas.json', import.meta.url), 'utf8'))
  const atlas = validateAtlas(snapshot)
  expect(atlas.schema_version).toBe(3)
  expect(atlas.layout).toBe('territories')
  expect(snapshot.languages).toHaveLength(10)
  const size = { width: 959, height: 586 }
  const measure = (text: string) => text.length * 7
  const { radius } = fileSizeScale(atlas.repos)
  const fit = fitOverview(atlas, false, size, radius, measure, 13)
  expect(placeRegionLabels(atlas, false, fit, size, radius, measure, 13)).toHaveLength(atlas.clusters.length)
})
