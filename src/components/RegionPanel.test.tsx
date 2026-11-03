// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { atlasPresentation } from '../presentation'
import { makeAtlas, makeRepo } from '../test-fixtures'
import { RegionPanel } from './RegionPanel'

afterEach(cleanup)

it('shows full-region statistics and the three most recent repositories with name tie breaks', () => {
  const repos = [
    makeRepo({ full_name: 'owner/zeta', name: 'zeta', pushed_at: '2026-09-01', primary_language: 'Python' }),
    makeRepo({ full_name: 'owner/alpha', name: 'alpha', pushed_at: '2026-09-01' }),
    makeRepo({ full_name: 'owner/middle', name: 'middle', pushed_at: '2025-07-01', primary_language: 'Python' }),
    makeRepo({ full_name: 'owner/oldest', name: 'oldest', created_at: '2019-02-01' }),
  ]
  const atlas = makeAtlas(repos)
  render(<RegionPanel cluster={atlas.clusters[0]} members={repos} visible={new Set(['owner/oldest'])}
    presentation={atlasPresentation(atlas)} onClose={vi.fn()} onSelect={vi.fn()} onClear={vi.fn()} fallbackLabel={false} />)
  expect(screen.getByText('1 matching / 4 repositories')).toBeDefined()
  expect(screen.getByText('Activity: Feb 2019 – Sep 2026')).toBeDefined()
  const mix = screen.getByRole('region', { name: 'Region language mix' })
  expect(within(mix).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Python 2', 'TypeScript 2'])
  const recent = screen.getByRole('region', { name: 'Recent repositories' })
  expect(within(recent).getAllByRole('button').map(button => button.querySelector('strong')?.textContent))
    .toEqual(['alpha', 'zeta', 'middle'])
})
