// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { zoomTransform } from 'd3-zoom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { advanceCameraBy, installCameraClock, stubMedia, stubResizeObserver, uninstallCameraClock } from './test-dom'
import { makeAtlas, makeRepo } from './test-fixtures'
import type { AtlasData } from './types'

let width: number
let resize: ReturnType<typeof stubResizeObserver>

beforeEach(() => {
  installCameraClock()
  stubMedia({ compact: false, reduced: true })
  width = 1000
  resize = stubResizeObserver()
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    left: 0, top: 0, width, height: 700, right: width, bottom: 700,
    x: 0, y: 0, toJSON() {},
  }))
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'modelContext')
  uninstallCameraClock()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

// jsdom requires its own Window object rather than Vitest's Window proxy.
function mouse(target: Element | Window, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, buttons: type === 'mouseup' ? 0 : 1 })
  Object.defineProperty(event, 'view', { value: window })
  fireEvent(target, event)
}

const first = makeRepo({ x: 400, y: 400 })
const second = makeRepo({ full_name: 'owner/second', name: 'second', x: 600, y: 500, cluster_id: 1 })

async function mount(path: string, data: AtlasData = makeAtlas([first, { ...second, cluster_id: 0 }])) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
  let execute!: (input: unknown) => unknown
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: { registerTool(tool: { execute(input: unknown): unknown }) { execute = tool.execute } },
  })
  window.history.replaceState(null, '', path)
  const { container } = render(<App />)
  await act(async () => {})
  expect(execute).toBeDefined()
  return { container, update: (input: unknown) => act(() => { execute(input) }) }
}

function clickMap(element: Element, [x, y]: [number, number], detail = 1) {
  fireEvent.pointerDown(element, { clientX: x, clientY: y, pointerType: 'mouse' })
  fireEvent.pointerUp(element, { clientX: x, clientY: y, pointerType: 'mouse' })
  fireEvent.click(element, { clientX: x, clientY: y, detail })
}

it('recenters and supersedes an uncommitted click when WebMCP repeats the selected repo', async () => {
  const { container, update } = await mount('/?repo=owner%2Fexample')
  const svg = container.querySelector('svg.atlas-map')!
  fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
  const initialCamera = zoomTransform(svg)

  mouse(svg, 'mousedown', 400, 300)
  mouse(window, 'mousemove', 340, 330)
  mouse(window, 'mouseup', 340, 330)
  advanceCameraBy(20)
  const pannedCamera = zoomTransform(svg)
  expect(pannedCamera.toString()).not.toBe(initialCamera.toString())

  const [x, y] = pannedCamera.apply([second.x, second.y])
  expect(x).toBeGreaterThan(0)
  expect(x).toBeLessThan(1000)
  expect(y).toBeGreaterThan(0)
  expect(y).toBeLessThan(700)
  clickMap(svg, [x, y])
  update({ repo: first.full_name, languages: ['Python'] })
  expect(zoomTransform(svg).apply([first.x, first.y])).toEqual([500, 326])
  advanceCameraBy(350)
  expect(screen.getByRole('complementary', { name: 'example details' })).toBeDefined()
})

it('zooms from the recentered camera after WebMCP supersedes a committed click', async () => {
  const { container, update } = await mount('/')
  const svg = container.querySelector('svg.atlas-map')!
  const [x, y] = zoomTransform(svg).apply([second.x, second.y])
  clickMap(svg, [x, y])
  advanceCameraBy(350)
  expect(screen.getByRole('complementary', { name: 'second details' })).toBeDefined()
  update({ repo: second.full_name })
  const centered = zoomTransform(svg)
  fireEvent.doubleClick(svg, { clientX: x, clientY: y, detail: 2 })
  expect(screen.getByRole('complementary', { name: 'second details' })).toBeDefined()
  expect(zoomTransform(svg).k).toBeCloseTo(centered.k * 2)
})

it.each(['deep link', 'list'])('preserves camera navigation through a filter-only change in %s', async source => {
  const deepLink = source === 'deep link'
  if (deepLink) width = 0
  const { container, update } = await mount(deepLink ? '/?repo=owner%2Fexample' : '/')
  if (!deepLink) {
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    update({ repo: first.full_name })
  }
  update({ languages: ['Python'] })
  if (!deepLink) fireEvent.click(screen.getByRole('button', { name: 'Map' }))
  const svg = container.querySelector('svg.atlas-map')!
  if (deepLink) {
    width = 1000
    resize.notify(svg)
  }
  expect(zoomTransform(svg).apply([first.x, first.y])).toEqual([500, 326])
  expect(screen.getByRole('complementary', { name: 'example details' })).toBeDefined()
})

function territories() {
  const atlas = makeAtlas([first, second])
  atlas.schema_version = 3
  atlas.layout = 'territories'
  atlas.stats.cluster_count = 2
  const firstRegion = { ...atlas.clusters[0], key: 'developer-tools', label_anchor: { x: 400, y: 400 } }
  firstRegion.contours = { outer: [[[310, 310], [490, 310], [490, 490], [310, 490], [310, 310]]], inner: [] }
  const secondRegion = { ...firstRegion, id: 1, key: 'second-region', label: 'Second Region', label_anchor: { x: 600, y: 500 } }
  secondRegion.contours = { outer: [[[510, 410], [690, 410], [690, 590], [510, 590], [510, 410]]], inner: [] }
  atlas.clusters = [firstRegion, secondRegion]
  return atlas
}

it.each(['territory', 'background'])('restores the repo and prior focus after a late %s double-click', async kind => {
  const { container } = await mount('/?repo=owner%2Fexample&focus=developer-tools', territories())
  const svg = container.querySelector('svg.atlas-map')!
  const before = zoomTransform(svg)
  const point: [number, number] = kind === 'territory' ? before.apply([655, 550]) : [5, 5]
  const target = kind === 'territory' ? container.querySelector('[data-territory="Second Region"]')! : svg
  clickMap(target, point)
  advanceCameraBy(350)
  const region = kind === 'territory' ? 'Second Region' : 'Developer Tools'
  expect(screen.getByRole('complementary', { name: `${region} region details` })).toBeDefined()
  fireEvent.doubleClick(svg, { clientX: point[0], clientY: point[1], detail: 2 })
  expect(screen.getByRole('complementary', { name: 'example details' })).toBeDefined()
  expect(new URLSearchParams(location.search).get('focus')).toBe('developer-tools')
  expect(zoomTransform(svg).k).toBeCloseTo(before.k * 2)
})

function touch([clientX, clientY]: [number, number], pointerId = 1) {
  return { clientX, clientY, pointerType: 'touch', pointerId }
}

function tap(element: Element, point: [number, number]) {
  const event = touch(point)
  fireEvent.pointerDown(element, event)
  fireEvent.pointerUp(element, event)
  fireEvent.click(element, { ...event, detail: 1 })
}

it('gives a nearby repo priority over a territory fill on touch', async () => {
  const { container } = await mount('/', territories())
  const svg = container.querySelector('svg.atlas-map')!
  const [x, y] = zoomTransform(svg).apply([first.x, first.y])
  tap(container.querySelector('[data-territory="Developer Tools"]')!, [x + 12, y])
  advanceCameraBy(300)
  expect(screen.getByRole('complementary', { name: 'example details' })).toBeDefined()
  expect(new URLSearchParams(location.search).get('focus')).toBeNull()
})

it('double-taps a territory to zoom without changing repo selection or focus', async () => {
  const { container } = await mount('/?repo=owner%2Fexample&focus=developer-tools', territories())
  const svg = container.querySelector('svg.atlas-map')!
  const before = zoomTransform(svg)
  const fill = container.querySelector('[data-territory="Second Region"]')!
  const [x, y] = before.apply([655, 550])
  tap(fill, [x, y])
  advanceCameraBy(100)
  tap(fill, [x + 8, y])
  fireEvent.doubleClick(svg, { clientX: x + 8, clientY: y, detail: 2 })
  advanceCameraBy(350)
  expect(zoomTransform(svg).k).toBeCloseTo(before.k * 2)
  expect(screen.getByRole('complementary', { name: 'example details' })).toBeDefined()
  expect(new URLSearchParams(location.search).get('focus')).toBe('developer-tools')
})

it.each(['drag', 'pinch', 'pointer cancel'])('cancels a queued tap after a %s', async gesture => {
  const { container } = await mount('/', territories())
  const svg = container.querySelector('svg.atlas-map')!
  const point = zoomTransform(svg).apply([460, 450])
  const fill = container.querySelector('[data-territory="Developer Tools"]')!
  tap(fill, point)
  const firstTouch = touch(point)
  fireEvent.pointerDown(fill, firstTouch)
  if (gesture === 'pinch') {
    const secondTouch = touch([point[0] + 30, point[1]], 2)
    fireEvent.pointerDown(fill, secondTouch)
    fireEvent.pointerUp(fill, secondTouch)
  } else if (gesture === 'drag') {
    fireEvent.pointerMove(fill, { ...firstTouch, clientX: point[0] + 16 })
  } else fireEvent.pointerCancel(fill, firstTouch)
  fireEvent.pointerUp(fill, firstTouch)
  advanceCameraBy(350)
  expect(screen.queryByRole('complementary', { name: 'Developer Tools region details' })).toBeNull()
  expect(new URLSearchParams(location.search).get('focus')).toBeNull()
})

it('restores the desktop guide opener after clearing filters and closing a region', async () => {
  await mount('/?lang=Python', territories())
  fireEvent.click(within(document.querySelector('.guide-panel') as HTMLElement).getByRole('button', { name: /Developer Tools/ }))
  const panel = screen.getByRole('complementary', { name: 'Developer Tools region details' })
  const clear = within(panel).getByRole('button', { name: 'Clear filters' })
  clear.focus()
  fireEvent.click(clear)
  expect(document.activeElement).toBe(within(panel).getByRole('heading', { name: 'Developer Tools' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Close details' }))
  advanceCameraBy(20)
  expect(document.activeElement).toBe(within(document.querySelector('.guide-panel') as HTMLElement).getByRole('button', { name: /Developer Tools/ }))
})

it('focuses Reset view after closing a region without an opener on mobile', async () => {
  stubMedia({ compact: true, reduced: true })
  await mount('/?focus=developer-tools', territories())
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
  advanceCameraBy(20)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reset view' }))
})

it.each([false, true])('focuses List after closing a region in List mode (compact=%s)', async compact => {
  stubMedia({ compact, reduced: true })
  await mount('/?focus=developer-tools', territories())
  const list = screen.getByRole('button', { name: 'List' })
  fireEvent.click(list)
  const close = screen.getByRole('button', { name: 'Close details' })
  close.focus()
  fireEvent.click(close)
  advanceCameraBy(20)
  expect(document.activeElement).toBe(list)
})
