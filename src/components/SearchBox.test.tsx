// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRepo } from '../test-fixtures'
import { stubScrollIntoView } from '../test-dom'
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

  it('does not claim the slash key from another editable field', async () => {
    const user = userEvent.setup()
    render(
      <>
        <textarea aria-label="Notes" />
        <SearchBox repos={[makeRepo()]} onSelect={vi.fn()} />
      </>,
    )
    const notes = screen.getByRole('textbox', { name: 'Notes' })
    await user.type(notes, '/')
    expect((notes as HTMLTextAreaElement).value).toBe('/')
    expect(document.activeElement).not.toBe(screen.getByRole('combobox', { name: 'Search repositories' }))
  })

  it('focuses search for the slash shortcut outside editable fields', async () => {
    const user = userEvent.setup()
    const scroll = stubScrollIntoView()
    try {
      render(<SearchBox repos={[makeRepo()]} onSelect={vi.fn()} />)
      const search = screen.getByRole('combobox', { name: 'Search repositories' })
      const focus = vi.spyOn(search, 'focus')
      await user.keyboard('/')
      expect(document.activeElement).toBe(search)
      expect(focus).toHaveBeenCalledWith({ preventScroll: true })
      expect(scroll.mock).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
      expect(scroll.mock.mock.instances.at(-1)).toBe(search)
    } finally {
      scroll.restore()
    }
  })

  it('selects repository-name prefixes before exact language matches', async () => {
    const names = [
      makeRepo({ full_name: 'owner/rust-web', name: 'rust-web', primary_language: 'Unknown' }),
      makeRepo({ full_name: 'owner/rust-notes', name: 'rust-notes', primary_language: 'Unknown' }),
    ]
    const languages = Array.from({ length: 9 }, (_, index) => makeRepo({
      full_name: `owner/language-${index}`, name: `language-${index}`, primary_language: 'Rust',
    }))
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SearchBox repos={[...languages, ...names]} onSelect={onSelect} />)

    await user.type(screen.getByRole('combobox', { name: 'Search repositories' }), 'rust')
    const options = await screen.findAllByRole('option')
    expect(options[0].textContent).toContain('rust-notes')
    expect(options[1].textContent).toContain('rust-web')
    expect(options.slice(2).every(option => option.textContent?.includes('language-'))).toBe(true)
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(names[1])
  })
})
