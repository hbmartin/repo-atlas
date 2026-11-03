// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zoomTransform } from 'd3-zoom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { advanceCameraBy, installCameraClock, stubMedia, stubResizeObserver, uninstallCameraClock } from './test-dom'
import { makeAtlas, makeRepo } from './test-fixtures'

beforeEach(() => {
  installCameraClock()
  stubMedia({ compact: false, reduced: true })
  stubResizeObserver()
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700,
    x: 0, y: 0, toJSON() {},
  })
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

it('preserves panning and a queued click when WebMCP repeats the selected repo', async () => {
  const first = makeRepo({ x: 400, y: 400 })
  const second = makeRepo({ full_name: 'owner/second', name: 'second', x: 600, y: 500 })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => makeAtlas([first, second]) }))
  let execute: ((input: unknown) => unknown) | undefined
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: { registerTool(tool: { execute(input: unknown): unknown }) { execute = tool.execute } },
  })
  window.history.replaceState(null, '', '/?repo=owner%2Fexample')
  const { container } = render(<App />)
  await act(async () => {})
  expect(execute).toBeDefined()
  expect(screen.getByRole('complementary', { name: 'example details' })).toBeDefined()
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
  fireEvent.pointerDown(svg, { clientX: x, clientY: y, pointerType: 'mouse' })
  fireEvent.pointerUp(svg, { clientX: x, clientY: y, pointerType: 'mouse' })
  fireEvent.click(svg, { clientX: x, clientY: y, detail: 1 })
  act(() => { execute?.({ repo: first.full_name }) })

  expect(zoomTransform(svg).toString()).toBe(pannedCamera.toString())
  advanceCameraBy(299)
  expect(screen.getByRole('complementary', { name: 'example details' })).toBeDefined()
  expect(zoomTransform(svg).toString()).toBe(pannedCamera.toString())
  advanceCameraBy(1)
  expect(screen.getByRole('complementary', { name: 'second details' })).toBeDefined()
  expect(zoomTransform(svg).toString()).not.toBe(pannedCamera.toString())
})
