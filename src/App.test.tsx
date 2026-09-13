// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAtlas, makeRepo } from './test-fixtures'
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
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); this.querySelector<HTMLButtonElement>('button')?.focus() } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
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
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  vi.restoreAllMocks()
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
  it('opens the guide, marks the background inert, and restores focus on dismissal', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    const trigger = await screen.findByRole('button', { name: 'Atlas guide' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Atlas guide' })
    expect(container.querySelector('.workspace')?.hasAttribute('inert')).toBe(true)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(within(dialog).getByRole('region', { name: 'Repository size legend' })).toBeDefined()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(container.querySelector('.workspace')?.hasAttribute('inert')).toBe(false)
  })

  it('normalizes legacy links and reports matching repositories and regions', async () => {
    const data = makeAtlas([makeRepo({ primary_language: 'Java' }), makeRepo({ full_name: 'owner/other', primary_language: 'Python' })])
    data.languages = [{ name: 'Java', color: '#000', count: 1 }, { name: 'Python', color: '#fff', count: 1 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
    window.history.replaceState(null, '', '?lang=Java')
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    expect(screen.getByText('1 matching / 2 repositories · 1 matching / 1 regions')).toBeDefined()
    expect(window.location.search).toBe('?lang=Other')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Filter by Other: 1 repositories' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('normalizes retired WebMCP filters and composes with the latest state', async () => {
    const data = makeAtlas([makeRepo({ primary_language: 'Java' })])
    data.languages = [{ name: 'Java', color: '#000', count: 1 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
    let execute: ((input: unknown) => { languages: string[] }) | undefined
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool(tool: { execute: typeof execute }) { execute = tool.execute } } })
    render(<App />)
    await waitFor(() => expect(execute).toBeDefined())
    act(() => {
      expect(execute!({ languages: ['Java', 'Other'] }).languages).toEqual(['Other'])
      expect(execute!({ repo: 'owner/example' }).languages).toEqual(['Other'])
    })
    expect(window.location.search).toContain('lang=Other')
  })

  it('restores normalized filter state on history navigation', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    await user.click(screen.getByRole('button', { name: 'Filter by TypeScript: 1 repositories' }))
    expect(screen.getByText('1 matching / 1 repositories · 1 matching / 1 regions')).toBeDefined()
    act(() => { window.history.replaceState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByText(/1 repositories · 1 regions · rebuilt/)).toBeDefined()
  })

})
