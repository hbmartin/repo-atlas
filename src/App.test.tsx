// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAtlas } from './test-fixtures'
import App from './App'

vi.mock('./components/MapView', () => ({ MapView: () => <div>Map fixture</div> }))

let mobileMatches = true
let mobileListener: (() => void) | undefined

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => makeAtlas(),
  }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  mobileMatches = true
  mobileListener = undefined
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === '(max-width: 1023px)' && mobileMatches },
    addEventListener(_type: string, listener: () => void) { mobileListener = listener },
    removeEventListener() {},
  }))
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'modelContext')
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('App mobile filters', () => {
  it('moves focus into the modal, closes on Escape, and restores focus', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    const trigger = screen.getByRole('button', { name: 'Filters' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Filter the atlas' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('reports rejected fetches as network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    render(<App />)
    expect(await screen.findByText('DATA LINK LOST')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'The atlas could not be loaded.' })).toBeDefined()
  })

  it('closes the mobile dialog and restores the page when resized to desktop', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    expect(container.querySelector('.topbar')?.hasAttribute('inert')).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    mobileMatches = false
    act(() => mobileListener?.())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(container.querySelector('.topbar')?.hasAttribute('inert')).toBe(false)
    expect(document.body.style.overflow).toBe('')
  })

  it('composes consecutive model-context updates from the latest view', async () => {
    let execute: ((input: unknown) => unknown) | undefined
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool(tool: { execute(input: unknown): unknown }) {
          execute = tool.execute
        },
      },
    })
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    await waitFor(() => expect(execute).toBeDefined())
    const first = execute!({ languages: ['TypeScript'] }) as { languages: string[] }
    const second = execute!({ repo: 'owner/example' }) as { languages: string[] }
    expect(first.languages).toEqual(['TypeScript'])
    expect(second.languages).toEqual(['TypeScript'])
  })

  it('links Source & method to the actual atlas repository', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    expect(screen.getByRole('link', { name: 'Source & method ↗' }).getAttribute('href'))
      .toBe('https://github.com/hbmartin/repo-atlas')
  })
})
