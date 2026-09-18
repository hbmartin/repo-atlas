// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ViewState } from '../types'
import { ActiveFilters } from './ActiveFilters'

afterEach(cleanup)

it('replaces the since chip when its month changes', () => {
  const onRemove = vi.fn()
  const view: ViewState = { repo: null, languages: [], regions: [], since: '2025-05', layoutAlt: false }
  const rendered = render(<ActiveFilters view={view} onRemove={onRemove} />)
  const chip = screen.getByRole('button', { name: 'Remove updated since filter May 2025' })
  chip.focus()

  rendered.rerender(<ActiveFilters view={{ ...view, since: '2025-06' }} onRemove={onRemove} />)

  const updated = screen.getByRole('button', { name: 'Remove updated since filter Jun 2025' })
  expect(updated).not.toBe(chip)
  fireEvent.click(updated)
  expect(onRemove).toHaveBeenCalledWith({ kind: 'since', value: '2025-06' })
})
