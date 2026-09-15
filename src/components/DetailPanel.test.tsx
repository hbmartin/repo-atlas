// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRepo } from '../test-fixtures'
import { DetailPanel } from './DetailPanel'

afterEach(cleanup)

describe('DetailPanel', () => {
  it('only dismisses from a downward touch drag on the sheet handle', () => {
    const repo = makeRepo()
    const onClose = vi.fn()
    const { container } = render(
      <DetailPanel
        repo={repo}
        cluster={undefined}
        reposByName={new Map([[repo.full_name, repo]])}
        onSelect={vi.fn()}
        onRegion={vi.fn()}
        onClose={onClose}
      />,
    )
    const panel = screen.getByLabelText('example details')
    fireEvent.pointerDown(panel, { pointerType: 'mouse', clientY: 10 })
    fireEvent.pointerUp(panel, { pointerType: 'mouse', clientY: 150 })
    expect(onClose).not.toHaveBeenCalled()
    const handle = container.querySelector('.sheet-handle')!
    fireEvent.pointerDown(handle, { pointerType: 'touch', clientY: 10 })
    fireEvent.pointerUp(handle, { pointerType: 'touch', clientY: 100 })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('distinguishes a truncated tree from sparse summary evidence', () => {
    const repo = makeRepo({ tree_truncated: true, low_confidence: false })
    render(
      <DetailPanel
        repo={repo}
        cluster={undefined}
        reposByName={new Map([[repo.full_name, repo]])}
        onSelect={vi.fn()}
        onRegion={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/truncated the repository tree/)).toBeDefined()
    expect(screen.queryByText(/little or no README/)).toBeNull()
  })
  it('shows raw primary language while the map category is Other', () => {
    const repo = makeRepo({ primary_language: 'Java', primary_language_category: 'Other', languages: [{ name: 'Java', pct: 100, color: '#b07219' }] })
    render(<DetailPanel repo={repo} cluster={undefined} reposByName={new Map([[repo.full_name, repo]])}
      onSelect={vi.fn()} onRegion={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Java')).toBeDefined()
    expect(screen.getByLabelText('Language composition: Java 100%')).toBeDefined()
    expect(screen.queryByText('Other')).toBeNull()
  })
})
