import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { validateAtlas } from '../../src/data'

it('validates the committed deployable atlas before build', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../public/atlas.json', import.meta.url), 'utf8'))
  const atlas = validateAtlas(snapshot)
  expect(atlas.stats.repo_count).toBe(atlas.repos.length)
  expect(atlas.repos.length).toBeGreaterThan(0)
  expect(snapshot.languages).toHaveLength(10)
})
