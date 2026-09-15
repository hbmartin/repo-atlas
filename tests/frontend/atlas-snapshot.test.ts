import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { validateAtlas } from '../../src/data'

it('validates the committed deployable atlas before build', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../public/atlas.json', import.meta.url), 'utf8'))
  validateAtlas(snapshot)
  expect(snapshot.languages).toHaveLength(10)
})
