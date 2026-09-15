// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import type { MapView } from './components/MapView'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAtlas, makeRepo } from './test-fixtures'
import { stubMedia } from './test-dom'
import App from './App'

const { mapSpy } = vi.hoisted(() => ({ mapSpy: vi.fn() }))
vi.mock('./components/MapView', () => ({ MapView: (props: ComponentProps<typeof MapView>) => { mapSpy(props); return <div>Map fixture</div> } }))
const currentMap = () => mapSpy.mock.lastCall![0] as ComponentProps<typeof MapView>

let media: ReturnType<typeof stubMedia>

beforeEach(() => {
  mapSpy.mockClear()
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
  media = stubMedia({ compact: true, reduced: false })
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
    media.set({ compact: false })
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

  it('filters Java- and HTML-primary repositories through Other while preserving raw languages', async () => {
    const data = makeAtlas([
      makeRepo({ primary_language: 'Java', primary_language_category: 'Other' }),
      makeRepo({ full_name: 'owner/html', name: 'html', primary_language: 'HTML', primary_language_category: 'Other' }),
      makeRepo({ full_name: 'owner/python', name: 'python', primary_language: 'Python' }),
    ])
    data.languages = [{ name: 'Other', color: '#DDDDDD', count: 2 }, { name: 'Python', color: '#77AADD', count: 1 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
    window.history.replaceState(null, '', '?lang=Other')
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    expect(screen.getByText('2 matching / 3 repositories · 1 matching / 1 regions')).toBeDefined()
    expect(window.location.search).toBe('?lang=Other')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Filter by Other: 2 repositories' }).getAttribute('aria-pressed')).toBe('true')
    expect(currentMap().visible.has('owner/example')).toBe(true)
    expect(currentMap().visible.has('owner/html')).toBe(true)
    expect(currentMap().visible.has('owner/python')).toBe(false)
  })

  it('preserves WebMCP language filters and composes with the latest state', async () => {
    const data = makeAtlas([makeRepo({ primary_language: 'Java', primary_language_category: 'Other' })])
    data.languages = [{ name: 'Other', color: '#DDDDDD', count: 1 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
    let execute: ((input: unknown) => { languages: string[]; regions: string[] }) | undefined
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool(tool: { execute: typeof execute }) { execute = tool.execute } } })
    render(<App />)
    await waitFor(() => expect(execute).toBeDefined())
    act(() => {
      const result = execute!({
        languages: ['Other', 'Other'],
        regions: ['Developer Tools', 'Developer Tools'],
      })
      expect(result.languages).toEqual(['Other'])
      expect(result.regions).toEqual(['Developer Tools'])
      expect(execute!({ repo: 'owner/example' }).languages).toEqual(['Other'])
    })
    expect(window.location.search).toContain('lang=Other')
    expect(new URLSearchParams(window.location.search).get('region')).toBe('Developer Tools')
    expect(currentMap().view.regions).toEqual(['Developer Tools'])
  })

  it('accepts exact raw primary languages alongside map categories in links and WebMCP', async () => {
    const data = makeAtlas([
      makeRepo({ primary_language: 'Java' }),
      makeRepo({ full_name: 'owner/html', primary_language: 'HTML' }),
      makeRepo({ full_name: 'owner/cpp', primary_language: 'C++' }),
      makeRepo({ full_name: 'owner/python', primary_language: 'Python' }),
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
    window.history.replaceState(null, '', '?lang=Java')
    let execute: ((input: unknown) => { languages: string[] }) | undefined
    let schema: { properties: { languages: { items: { enum: string[] } } } } | undefined
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool: { execute: typeof execute; inputSchema: typeof schema }) { execute = tool.execute; schema = tool.inputSchema },
    } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    await waitFor(() => expect(execute).toBeDefined())
    expect(currentMap().visible.has('owner/example')).toBe(true)
    expect(currentMap().visible.has('owner/html')).toBe(false)
    expect(screen.getByRole('button', { name: 'Remove language filter Java' })).toBeDefined()
    expect(schema?.properties.languages.items.enum).toContain('Java')
    expect(schema?.properties.languages.items.enum).toContain('Other')
    expect(schema?.properties.languages.items.enum).toContain('Rust')
    act(() => { expect(execute!({ languages: ['Java', 'Python'] }).languages).toEqual(['Java', 'Python']) })
    expect(screen.getByRole('button', { name: 'Remove language filter Python' })).toBeDefined()
    expect(currentMap().visible.has('owner/example')).toBe(true)
    expect(currentMap().visible.has('owner/html')).toBe(false)
    expect(currentMap().visible.has('owner/python')).toBe(true)
    act(() => { expect(execute!({ languages: ['Other'] }).languages).toEqual(['Other']) })
    expect(currentMap().visible.has('owner/html')).toBe(true)
    expect(currentMap().visible.has('owner/cpp')).toBe(true)
    expect(currentMap().visible.has('owner/python')).toBe(false)
    expect(() => execute!({ languages: ['Gleam'] })).toThrow('Unknown language category or raw primary-language filter')
  })

  it('shows a removable chip for a zero-count WebMCP language category', async () => {
    const user = userEvent.setup()
    let execute: ((input: unknown) => unknown) | undefined
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool: { execute(input: unknown): unknown }) { execute = tool.execute },
    } })
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    await waitFor(() => expect(execute).toBeDefined())
    act(() => { execute!({ languages: ['Rust'] }) })
    expect(currentMap().visible.size).toBe(0)
    expect(screen.getByRole('button', { name: 'Remove language filter Rust' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Remove language filter Rust' }))
    expect(currentMap().visible.size).toBe(1)
  })

  it('preserves unknown URL state and the hash until an explicit atlas change', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/?lang=TypeScript&wat=1#saved-place')
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    expect(window.location.search).toBe('?lang=TypeScript&wat=1')
    expect(window.location.hash).toBe('#saved-place')
    expect(screen.getByRole('status').textContent).toContain('wat')
    await user.click(screen.getByRole('button', { name: 'Filter by TypeScript: 1 repositories' }))
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('preserves unknown URL state and the hash during popstate restoration', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Repo Atlas' })
    act(() => {
      window.history.pushState(null, '', '/?region=Developer+Tools&wat=1#history-place')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(currentMap().view.regions).toEqual(['Developer Tools'])
    expect(window.location.search).toBe('?region=Developer+Tools&wat=1')
    expect(window.location.hash).toBe('#history-place')
    expect(screen.getByRole('status').textContent).toContain('wat')
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

it('shows fallback provenance in the guide and selected repository region card', async () => {
  const data = { ...makeAtlas(), fallback_label_ids: [0] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
  const user = userEvent.setup()
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  expect(screen.getByText('Fallback label')).toBeDefined()
  const region = screen.getByRole('button', { name: /Developer Tools Fallback label/ })
  fireEvent.focus(region)
  expect(screen.getByText('Named from repository domains because model labeling was unavailable.')).toBeDefined()
  // A deep link exercises the same selected-repository flow as map selection.
  window.history.pushState(null, '', '?repo=owner%2Fexample')
  act(() => window.dispatchEvent(new PopStateEvent('popstate')))
  const details = await screen.findByLabelText('example details')
  expect(within(details).getByText('Fallback label')).toBeDefined()
  expect(within(details).getByText('Named from repository domains because model labeling was unavailable.')).toBeDefined()
  await user.click(within(details).getByRole('button', { name: 'Close details' }))
  expect(await screen.findByText('Fallback label')).toBeDefined()
})

it('does not mark labels in legacy data as fallbacks', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  expect(screen.queryByText('Fallback label')).toBeNull()
})

it('shows and individually removes raw-language, region, and date chips without changing selection or layout', async () => {
  const user = userEvent.setup()
  const data = makeAtlas([makeRepo({ primary_language: 'Java' }), makeRepo({ full_name: 'owner/python', primary_language: 'Python' })])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
  window.history.replaceState(null, '', '/?repo=owner%2Fexample&lang=Java&region=Developer+Tools&since=2025-06&layout=alt')
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  expect(screen.getByRole('button', { name: 'Remove language filter Java' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Remove region filter Developer Tools' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Remove updated since filter Jun 2025' })).toBeDefined()
  await user.click(screen.getByRole('button', { name: 'Remove region filter Developer Tools' }))
  expect(currentMap().view).toMatchObject({ repo: 'owner/example', languages: ['Java'], regions: [], since: '2025-06', layoutAlt: true })
  await user.click(screen.getByRole('button', { name: 'Remove updated since filter Jun 2025' }))
  expect(currentMap().view.since).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Remove language filter Java' }))
  expect(currentMap().view).toMatchObject({ repo: 'owner/example', languages: [], layoutAlt: true })
  expect(window.location.search).toContain('layout=alt')
  expect(window.location.search).toContain('repo=owner%2Fexample')
})

it('keeps zero-count saved-link filters visible as chips while hiding empty filter choices', async () => {
  const user = userEvent.setup()
  window.history.replaceState(null, '', '/?lang=Rust')
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  expect(currentMap().visible.size).toBe(0)
  expect(screen.queryByRole('button', { name: 'Filter by Rust: 0 repositories' })).toBeNull()
  const dialogTrigger = screen.getByRole('button', { name: 'Filters · 1' })
  await user.click(dialogTrigger)
  const dialog = screen.getByRole('dialog', { name: 'Filter the atlas' })
  expect(within(dialog).getByRole('button', { name: 'Remove language filter Rust' })).toBeDefined()
  await user.click(within(dialog).getByText('Language · 1'))
  expect(within(dialog).queryByRole('checkbox', { name: /Rust/ })).toBeNull()
  expect(within(dialog).queryByRole('checkbox', { name: /Unclustered/ })).toBeNull()
  await user.click(within(dialog).getByRole('button', { name: 'Remove language filter Rust' }))
  expect(currentMap().visible.size).toBe(1)
  expect(window.location.search).toBe('')
})

it('clears every filter inside the mobile dialog while keeping selection and layout', async () => {
  const user = userEvent.setup()
  window.history.replaceState(null, '', '/?repo=owner%2Fexample&lang=TypeScript&region=Developer+Tools&since=2025-06&layout=alt')
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  await user.click(screen.getByRole('button', { name: 'Filters · 3' }))
  const dialog = screen.getByRole('dialog', { name: 'Filter the atlas' })
  await user.click(within(dialog).getByRole('button', { name: 'Clear all' }))
  expect(currentMap().view).toMatchObject({ repo: 'owner/example', languages: [], regions: [], since: null, layoutAlt: true })
  expect(within(dialog).queryByRole('group', { name: 'Active filters' })).toBeNull()
})


it('acknowledges only the current navigation request and does not replay consumed requests', async () => {
  const first = makeRepo(), second = makeRepo({ full_name: 'owner/second', name: 'second' })
  const data = makeAtlas([first, second])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
  window.history.replaceState(null, '', '?repo=owner%2Fexample')
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  const old = currentMap()
  expect(old.navigationRequest).toMatchObject({ kind: 'repo', target: first.full_name })
  act(() => old.onSelect(second))
  const newer = currentMap().navigationRequest!
  act(() => old.onNavigationHandled?.(old.navigationRequest!.nonce))
  expect(currentMap().navigationRequest).toEqual(newer)
  act(() => currentMap().onNavigationHandled?.(newer.nonce))
  expect(currentMap().navigationRequest).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  fireEvent.click(screen.getByRole('button', { name: 'Map' }))
  expect(currentMap().navigationRequest).toBeNull()
})

it('keeps presentation and visibility stable on selection and projection updates', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  const before = currentMap()
  act(() => before.onSelect(before.data.repos[0]))
  expect(currentMap().presentation).toBe(before.presentation)
  expect(currentMap().visible).toBe(before.visible)
  fireEvent.click(screen.getByRole('button', { name: 'Alternate layout' }))
  expect(currentMap().presentation).toBe(before.presentation)
  expect(currentMap().visible).toBe(before.visible)
  expect(currentMap().view.languages).toBe(before.view.languages)
})

it('presents guide regions as persistent focus actions rather than toggles', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Repo Atlas' })
  const region = screen.getByRole('button', { name: /Developer Tools/ })
  expect(region.hasAttribute('aria-pressed')).toBe(false)
  fireEvent.click(region)
  expect(region.getAttribute('aria-current')).toBe('true')
  const request = currentMap().navigationRequest!
  act(() => currentMap().onNavigationHandled?.(request.nonce))
  fireEvent.click(region)
  expect(currentMap().view.regions).toEqual(['Developer Tools'])
  expect(currentMap().navigationRequest!.nonce).toBeGreaterThan(request.nonce)
})

it('synchronizes native dialog closure and ignores close events from a reopened dialog', async () => {
  render(<App />)
  const trigger = await screen.findByRole('button', { name: 'Atlas guide' })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Atlas guide' }) as HTMLDialogElement
  fireEvent(dialog, new Event('close'))
  expect(screen.getByRole('dialog', { name: 'Atlas guide' })).toBe(dialog)
  dialog.close()
  fireEvent(dialog, new Event('close'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('.workspace')?.hasAttribute('inert')).toBe(false)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Atlas guide' }))
})
