// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRepo } from '../test-fixtures'
import { SearchBox } from './SearchBox'

afterEach(cleanup)

describe('SearchBox', () => {
  it('exposes an accessible listbox and selects the exact name first', async () => {
    const exact = makeRepo({ full_name: 'owner/graphviz2drawio', name: 'graphviz2drawio' })
    const formula = makeRepo({ full_name: 'owner/homebrew-graphviz2drawio', name: 'homebrew-graphviz2drawio' })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SearchBox repos={[formula, exact]} onSelect={onSelect} />)
    const search = screen.getByRole('combobox', { name: 'Search repositories' })
    await user.type(search, 'graphviz2drawio')
    const options = await screen.findAllByRole('option')
    expect(options[0].textContent).toContain('graphviz2drawio')
    expect(options[0].textContent).not.toContain('homebrew')
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0].id)
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(exact)
  })
})
