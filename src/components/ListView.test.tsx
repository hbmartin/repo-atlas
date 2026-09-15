// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeAtlas, makeRepo } from '../test-fixtures'
import { ListView } from './ListView'

afterEach(cleanup)

it('shows raw languages rather than map categories in list rows', () => {
  const repo = makeRepo({ primary_language: 'HTML', primary_language_category: 'Other' })
  const data = makeAtlas([repo])
  render(<ListView data={data} visible={new Set([repo.full_name])} onSelect={vi.fn()} />)
  expect(screen.getByText(/HTML ·/)).toBeDefined()
  expect(screen.queryByText(/Other ·/)).toBeNull()
})
