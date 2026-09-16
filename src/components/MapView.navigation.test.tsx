// @vitest-environment jsdom
import { useMemo, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zoomTransform } from 'd3-zoom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AtlasRepo, MapNavigationRequest, ViewState } from '../types'
import { atlasPresentation } from '../presentation'
import { advanceCameraBy, finishCameraTransition, installCameraClock, stubMedia, uninstallCameraClock } from '../test-dom'
import { makeAtlas, makeRepo } from '../test-fixtures'
import { MapView } from './MapView'

const { placementSpy } = vi.hoisted(() => ({ placementSpy: vi.fn() }))
vi.mock('../map-geometry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../map-geometry')>()
  return {
    ...original,
    placeRegionLabels: (...args: Parameters<typeof original.placeRegionLabels>) => {
      placementSpy(args[2].toString())
      return original.placeRegionLabels(...args)
    },
  }
})

const empty: ViewState = { repo: null, languages: [], regions: [], since: null, layoutAlt: false }
const first = makeRepo({ x: 200, y: 200, x_alt: 250, y_alt: 250 })
const second = makeRepo({ full_name: 'owner/second', name: 'second', x: 700, y: 600, x_alt: 650, y_alt: 550, cluster_id: 1 })
const data = makeAtlas([first, second])
data.clusters[0] = { ...data.clusters[0], label_anchor: { x: 200, y: 200 }, contours: { outer: [[[100, 100], [300, 100], [300, 300], [100, 300]]], inner: [] } }
data.clusters.push({ ...data.clusters[0], id: 1, label: 'Second Region', label_anchor: { x: 700, y: 600 }, contours: { outer: [[[600, 500], [800, 500], [800, 700], [600, 700]]], inner: [] } })
const presentation = atlasPresentation(data)
const props = { data, presentation, view: empty, visible: new Set(data.repos.map(repo => repo.full_name)), selected: null, onSelect: vi.fn() }
let width = 1000, height = 700
let originLeft = 0, originTop = 0
let resize: (() => void) | undefined
type ResizeRegistration = { callback: ResizeObserverCallback; observer: ResizeObserver; targets: Set<Element> }
let resizeRegistrations: ResizeRegistration[] = []

function reportResize(target: Element, reportedWidth: number, reportedHeight: number) {
  const registration = resizeRegistrations.find(item => item.targets.has(target))
  if (!registration) throw new Error('Element is not observed')
  const borderBoxSize = [{ inlineSize: reportedWidth, blockSize: reportedHeight }] as ResizeObserverSize[]
  const entry = { target, borderBoxSize } as unknown as ResizeObserverEntry
  act(() => registration.callback([entry], registration.observer))
}

beforeEach(() => {
  installCameraClock()
  placementSpy.mockClear()
  width = 1000; height = 700; originLeft = 0; originTop = 0
  resize = undefined
  resizeRegistrations = []
  vi.stubGlobal('ResizeObserver', class {
    private registration: ResizeRegistration
    constructor(callback: ResizeObserverCallback) {
      this.registration = { callback, observer: this as unknown as ResizeObserver, targets: new Set() }
      resizeRegistrations.push(this.registration)
    }
    observe(target: Element) {
      this.registration.targets.add(target)
      if (target instanceof SVGSVGElement) resize = () => this.registration.callback([], this.registration.observer)
    }
    unobserve(target: Element) { this.registration.targets.delete(target) }
    disconnect() { this.registration.targets.clear() }
  })
  stubMedia({ compact: true, reduced: true })
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    left: originLeft, top: originTop, width, height, right: originLeft + width, bottom: originTop + height,
    x: originLeft, y: originTop, toJSON() {},
  }))
})
afterEach(() => { cleanup(); uninstallCameraClock(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function Harness({ initial = null }: { initial?: AtlasRepo | null }) {
  const [selected, setSelected] = useState(initial)
  const [request, setRequest] = useState<MapNavigationRequest | null>(null)
  const sequence = useRef(0)
  const view = useMemo(() => ({ ...empty, repo: selected?.full_name ?? null }), [selected])
  return <><output data-testid="selected">{selected?.full_name ?? 'none'}</output>
    <MapView {...props} view={view} selected={selected} navigationRequest={request}
      onNavigationHandled={nonce => setRequest(current => current?.nonce === nonce ? null : current)}
      onSelect={(repo, options) => {
        setSelected(repo)
        setRequest(repo && options?.navigate !== false ? { kind: 'repo', target: repo.full_name, nonce: ++sequence.current, clickToken: options?.clickToken } : null)
      }} /></>
}
function click(svg: SVGSVGElement, point: [number, number], detail = 1) {
  fireEvent.pointerDown(svg, { clientX: point[0], clientY: point[1], pointerType: 'mouse' })
  fireEvent.pointerUp(svg, { clientX: point[0], clientY: point[1], pointerType: 'mouse' })
  fireEvent.click(svg, { clientX: point[0], clientY: point[1], detail })
}

// Vitest's Window proxy is rejected by jsdom 30's UIEvent constructor.
function mouse(target: Element | Window, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true, buttons: type === 'mouseup' ? 0 : 1 })
  Object.defineProperty(event, 'view', { value: window })
  fireEvent(target, event)
}

describe('measured camera navigation', () => {
  it('fits a request present on mount exactly as one sent after measurement', () => {
    width = 390; height = 668
    const request = { kind: 'region' as const, target: 'Developer Tools', nonce: 1 }
    const handled = vi.fn()
    const mounted = render(<MapView {...props} navigationRequest={request} onNavigationHandled={handled} />)
    const initial = zoomTransform(mounted.container.querySelector('svg')!).toString()
    expect(handled).toHaveBeenCalledExactlyOnceWith(1)
    mounted.unmount()
    const later = render(<MapView {...props} />)
    later.rerender(<MapView {...props} navigationRequest={request} />)
    expect(zoomTransform(later.container.querySelector('svg')!).toString()).toBe(initial)
  })
  it('keeps a request pending until positive dimensions and acknowledges it once', () => {
    width = 0; height = 0
    const handled = vi.fn()
    const request = { kind: 'repo' as const, target: first.full_name, nonce: 2 }
    const { rerender } = render(<MapView {...props} navigationRequest={request} onNavigationHandled={handled} />)
    expect(handled).not.toHaveBeenCalled()
    width = 600; height = 400
    act(() => resize?.())
    expect(handled).toHaveBeenCalledExactlyOnceWith(2)
    rerender(<MapView {...props} navigationRequest={request} onNavigationHandled={handled} />)
    expect(handled).toHaveBeenCalledTimes(1)
  })
  it('keeps the placeholder camera synchronized until positive dimensions arrive', () => {
    width = 0; height = 0
    const { container } = render(<MapView {...props} />)
    const svg = container.querySelector('svg')!
    const placeholder = zoomTransform(svg)

    expect(placeholder.toString()).not.toBe('translate(0,0) scale(1)')
    expect(container.querySelector('.map-geometry')?.getAttribute('transform')).toBe(placeholder.toString())

    width = 600; height = 400
    act(() => resize?.())
    expect(container.querySelector('.map-geometry')?.getAttribute('transform')).toBe(zoomTransform(svg).toString())
  })
  it('completes animated repository navigation when reduced motion is off', () => {
    stubMedia({ compact: false, reduced: false })
    const request = { kind: 'repo' as const, target: second.full_name, nonce: 3 }
    const { container } = render(<MapView {...props} selected={second} navigationRequest={request} />)
    const svg = container.querySelector('svg')!
    const fit = zoomTransform(svg)

    finishCameraTransition()

    const centered = zoomTransform(svg)
    expect(centered.k / fit.k).toBeCloseTo(2.2)
    expect(centered.apply([second.x, second.y])[0]).toBeCloseTo(width / 2)
    expect(centered.apply([second.x, second.y])[1]).toBeCloseTo((height - 48) / 2)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('220%')
  })
  it('snaps an in-flight repository navigation to its rebased resize target', () => {
    stubMedia({ compact: false, reduced: false })
    const request = { kind: 'repo' as const, target: second.full_name, nonce: 31 }
    const { container } = render(<MapView {...props} selected={second} navigationRequest={request} />)
    const svg = container.querySelector('svg')!
    advanceCameraBy(40)
    expect(screen.getByLabelText('Zoom level').textContent).not.toBe('220%')

    width = 1010
    act(() => resize?.())

    const resized = zoomTransform(svg)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('220%')
    expect(resized.apply([second.x, second.y])[0]).toBeCloseTo(width / 2)
    expect(resized.apply([second.x, second.y])[1]).toBeCloseTo((height - 48) / 2)
    finishCameraTransition()
    expect(zoomTransform(svg).toString()).toBe(resized.toString())
  })
  it.each(['missing', 'Unclustered'])('acknowledges an empty region %s without moving', target => {
    const handled = vi.fn()
    const { container, rerender } = render(<MapView {...props} />)
    const svg = container.querySelector('svg')!
    const before = zoomTransform(svg).toString()
    rerender(<MapView {...props} navigationRequest={{ kind: 'region', target, nonce: 4 }} onNavigationHandled={handled} />)
    expect(zoomTransform(svg).toString()).toBe(before)
    expect(handled).toHaveBeenCalledExactlyOnceWith(4)
  })
  it('preserves panning and relative zoom on resize with a selected repository', () => {
    const request = { kind: 'repo' as const, target: first.full_name, nonce: 1 }
    const { container } = render(<MapView {...props} selected={first} navigationRequest={request} />)
    const svg = container.querySelector('svg')!
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    mouse(svg, 'mousedown', 400, 300)
    mouse(window, 'mousemove', 500, 350)
    mouse(window, 'mouseup', 500, 350)
    act(() => vi.advanceTimersByTime(20))
    const old = zoomTransform(svg).invert([width / 2, height / 2])
    const oldZoom = screen.getByLabelText('Zoom level').textContent
    width = 768; height = 550
    act(() => resize?.())
    const current = zoomTransform(svg).invert([width / 2, height / 2])
    expect(current[0]).toBeCloseTo(old[0])
    expect(current[1]).toBeCloseTo(old[1])
    expect(screen.getByLabelText('Zoom level').textContent).toBe(oldZoom)
  })
  it('renders label placement once with the resized fit and camera', () => {
    render(<MapView {...props} />)
    placementSpy.mockClear()
    width = 768; height = 550
    act(() => resize?.())
    expect(placementSpy).toHaveBeenCalledTimes(1)
  })
  it('keeps labels live without rebuilding static repository geometry each frame', () => {
    stubMedia({ compact: false, reduced: false })
    const currentPresentation = atlasPresentation(data)
    const languageColor = vi.spyOn(currentPresentation.languageColors, 'get')
    render(<MapView {...props} presentation={currentPresentation} />)
    placementSpy.mockClear()
    languageColor.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    advanceCameraBy(120)

    expect(placementSpy.mock.calls.length).toBeGreaterThan(1)
    expect(languageColor).not.toHaveBeenCalled()
  })
  it('renders geometry, labels, and HUD from the same in-flight camera', () => {
    stubMedia({ compact: false, reduced: false })
    const { container } = render(<MapView {...props} />)
    const svg = container.querySelector('svg')!
    const fit = zoomTransform(svg)
    placementSpy.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    advanceCameraBy(60)

    const camera = zoomTransform(svg)
    expect(container.querySelector('.map-geometry')?.getAttribute('transform')).toBe(camera.toString())
    expect(placementSpy).toHaveBeenLastCalledWith(camera.toString())
    expect(screen.getByLabelText('Zoom level').textContent).toBe(`${Math.round(camera.k / fit.k * 100)}%`)
  })
  it('keeps a resized destination after interrupting a wheel-owned animation', () => {
    stubMedia({ compact: false, reduced: false })
    const { container } = render(<MapView {...props} />)
    const svg = container.querySelector('svg')!

    fireEvent.wheel(svg, { clientX: 500, clientY: 350, deltaY: -100 })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    advanceCameraBy(160)
    width = 1010
    act(() => resize?.())
    const resized = zoomTransform(svg)
    finishCameraTransition()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    finishCameraTransition()
    expect(zoomTransform(svg).k).toBeCloseTo(resized.k * 1.25)
  })
  it('centers a repository from the pending reset destination', () => {
    stubMedia({ compact: false, reduced: false })
    const result = render(<MapView {...props} />)
    const svg = result.container.querySelector('svg')!
    const initial = zoomTransform(svg)
    for (let index = 0; index < 4; index += 1) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    finishCameraTransition()
    expect(zoomTransform(svg).k / initial.k).toBeGreaterThan(2.2)

    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    advanceCameraBy(40)
    result.rerender(<MapView {...props} selected={second} navigationRequest={{ kind: 'repo', target: second.full_name, nonce: 32 }} />)
    finishCameraTransition()

    expect(zoomTransform(svg).k / initial.k).toBeCloseTo(2.2)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('220%')
  })
})

describe('click sequences', () => {
  it('delays a single mouse selection and selects the hit repository', () => {
    const { container } = render(<Harness />)
    const svg = container.querySelector('svg')!
    click(svg, zoomTransform(svg).apply([second.x, second.y]))
    act(() => vi.advanceTimersByTime(299))
    expect(screen.getByTestId('selected').textContent).toBe('none')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId('selected').textContent).toBe(second.full_name)
  })
  it.each([100, 350])('double-click restores the original selection and camera basis after %s ms', delay => {
    const { container } = render(<Harness initial={first} />)
    const svg = container.querySelector('svg')!
    const before = zoomTransform(svg)
    const point = before.apply([second.x, second.y])
    click(svg, point)
    act(() => vi.advanceTimersByTime(delay))
    click(svg, point, 2)
    fireEvent.doubleClick(svg, { clientX: point[0], clientY: point[1], detail: 2 })
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByTestId('selected').textContent).toBe(first.full_name)
    const current = zoomTransform(svg)
    expect(current.k).toBeCloseTo(before.k * 2)
    expect(current.apply(before.invert(point))[0]).toBeCloseTo(point[0])
    expect(current.apply(before.invert(point))[1]).toBeCloseTo(point[1])
  })
  it('interrupts animated selection with a late double-click from the original camera basis', () => {
    stubMedia({ compact: false, reduced: false })
    const { container } = render(<Harness initial={first} />)
    const svg = container.querySelector('svg')!
    const before = zoomTransform(svg)
    const point = before.apply([second.x, second.y])
    click(svg, point)
    advanceCameraBy(340)
    expect(screen.getByTestId('selected').textContent).toBe(second.full_name)

    click(svg, point, 2)
    fireEvent.doubleClick(svg, { clientX: point[0], clientY: point[1], detail: 2 })
    finishCameraTransition()

    expect(screen.getByTestId('selected').textContent).toBe(first.full_name)
    const current = zoomTransform(svg)
    expect(current.k).toBeCloseTo(before.k * 2)
    expect(current.apply(before.invert(point))[0]).toBeCloseTo(point[0])
    expect(current.apply(before.invert(point))[1]).toBeCloseTo(point[1])
  })
  it('captures the live hit-test camera for an in-flight double-click', () => {
    stubMedia({ compact: false, reduced: false })
    const { container } = render(<Harness initial={first} />)
    const svg = container.querySelector('svg')!
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    advanceCameraBy(60)
    const live = zoomTransform(svg)
    const point = live.apply([second.x, second.y])

    click(svg, point)
    click(svg, point, 2)
    fireEvent.doubleClick(svg, { clientX: point[0], clientY: point[1], detail: 2 })
    finishCameraTransition()

    const current = zoomTransform(svg)
    expect(current.k).toBeCloseTo(live.k * 2)
    expect(current.apply(live.invert(point))[0]).toBeCloseTo(point[0])
    expect(current.apply(live.invert(point))[1]).toBeCloseTo(point[1])
  })
  it('clears a selection only after a single background click', () => {
    const { container } = render(<Harness initial={first} />)
    click(container.querySelector('svg')!, [5, 5])
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByTestId('selected').textContent).toBe('none')
  })
  it('activates a repository immediately from the keyboard', () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByRole('button', { name: /^second:/ }), { key: 'Enter' })
    expect(screen.getByTestId('selected').textContent).toBe(second.full_name)
  })
  it.each(['cancel', 'drag', 'unmount', 'supersede', 'filter'])('cancels delayed selection on %s', action => {
    const onSelect = vi.fn()
    const result = render(<MapView {...props} onSelect={onSelect} />)
    const svg = result.container.querySelector('svg')!
    click(svg, zoomTransform(svg).apply([first.x, first.y]))
    if (action === 'cancel') fireEvent.pointerCancel(svg)
    if (action === 'drag') {
      mouse(svg, 'mousedown', 100, 100)
      mouse(window, 'mousemove', 200, 100)
      mouse(window, 'mouseup', 200, 100)
    }
    if (action === 'filter') result.rerender(<MapView {...props} onSelect={onSelect} view={{ ...empty, languages: ['Java'] }} />)
    if (action === 'unmount') result.unmount()
    if (action === 'supersede') result.rerender(<MapView {...props} onSelect={onSelect} navigationRequest={{ kind: 'repo', target: second.full_name, nonce: 44 }} />)
    act(() => vi.advanceTimersByTime(400))
    expect(onSelect).not.toHaveBeenCalled()
  })
  it.each([100, 350])('focuses a double-clicked region once without map zoom after %s ms', delay => {
    const onRegion = vi.fn()
    const { container } = render(<MapView {...props} onRegion={onRegion} />)
    const before = zoomTransform(container.querySelector('svg')!).toString()
    const label = screen.getByRole('button', { name: 'Focus region: Developer Tools' })
    fireEvent.click(label, { detail: 1 })
    act(() => vi.advanceTimersByTime(delay))
    fireEvent.click(label, { detail: 2 })
    fireEvent.doubleClick(label, { detail: 2 })
    act(() => vi.advanceTimersByTime(400))
    expect(onRegion).toHaveBeenCalledTimes(1)
    expect(zoomTransform(container.querySelector('svg')!).toString()).toBe(before)
  })
  it('focuses a region after a prior drag left stale map pointer state', () => {
    const onRegion = vi.fn()
    const { container } = render(<MapView {...props} onRegion={onRegion} />)
    const svg = container.querySelector('svg')!
    const label = screen.getByRole('button', { name: 'Focus region: Developer Tools' })
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, pointerType: 'mouse', buttons: 1 })
    fireEvent.pointerMove(svg, { clientX: 200, clientY: 100, pointerType: 'mouse', buttons: 1 })
    fireEvent.pointerDown(label, { clientX: 300, clientY: 200, pointerType: 'mouse', buttons: 1 })
    fireEvent.pointerMove(svg, { clientX: 500, clientY: 200, pointerType: 'mouse', buttons: 0 })
    fireEvent.click(label, { detail: 1 })
    act(() => vi.advanceTimersByTime(300))
    expect(onRegion).toHaveBeenCalledExactlyOnceWith('Developer Tools', expect.any(Number))
  })
  it('does not treat pointer movement with no active button as a drag', () => {
    const { container } = render(<Harness />)
    const svg = container.querySelector('svg')!
    const point = zoomTransform(svg).apply([second.x, second.y])
    fireEvent.pointerDown(svg, { clientX: 5, clientY: 5, pointerType: 'mouse', buttons: 1 })
    fireEvent.pointerMove(svg, { clientX: point[0], clientY: point[1], pointerType: 'mouse', buttons: 0 })
    fireEvent.click(svg, { clientX: point[0], clientY: point[1], detail: 1 })
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByTestId('selected').textContent).toBe(second.full_name)
  })
})

it('clears a removed label highlight while retaining a guide-originated highlight', () => {
  const { container, rerender } = render(<MapView {...props} />)
  fireEvent.pointerEnter(screen.getByRole('button', { name: 'Focus region: Developer Tools' }))
  expect(container.querySelectorAll('.contour.active')).toHaveLength(1)
  const changed = { ...data, clusters: data.clusters.map(c => c.id === 0 ? { ...c, label: 'Unbreakable'.repeat(200) } : c) }
  const changedProps = { ...props, data: changed, presentation: atlasPresentation(changed) }
  rerender(<MapView {...changedProps} />)
  expect(container.querySelectorAll('.contour.active')).toHaveLength(0)
  rerender(<MapView {...changedProps} highlightRegion={0} />)
  expect(container.querySelectorAll('.contour.active')).toHaveLength(1)
})


it('restores selection after a late double-click on the background', () => {
  const { container } = render(<Harness initial={first} />)
  const svg = container.querySelector('svg')!
  click(svg, [5, 5])
  act(() => vi.advanceTimersByTime(350))
  expect(screen.getByTestId('selected').textContent).toBe('none')
  click(svg, [5, 5], 2)
  fireEvent.doubleClick(svg, { clientX: 5, clientY: 5, detail: 2 })
  expect(screen.getByTestId('selected').textContent).toBe(first.full_name)
})

it('renders category colors without changing raw repository languages', () => {
  const custom = makeAtlas([makeRepo({ primary_language: 'Java', primary_language_category: 'Other' }), makeRepo({ full_name: 'owner/unknown', primary_language: 'Unknown', primary_language_category: 'Unknown' })])
  custom.languages = [{ name: 'Other', count: 1, color: '#DDDDDD' }, { name: 'Unknown', count: 1, color: '#87909E' }]
  const { container } = render(<MapView {...props} data={custom} presentation={atlasPresentation(custom)} />)
  const circles = container.querySelectorAll('.repo-point .repo-dot')
  expect(circles[0].getAttribute('fill')).toBe('#DDDDDD')
  expect(circles[1].getAttribute('fill')).toBe('#87909E')
  const rings = container.querySelectorAll('.repo-point .focus-ring')
  expect(rings).toHaveLength(2)
  const fit = zoomTransform(container.querySelector('svg')!).k
  expect((Number(rings[0].getAttribute('r')) - Number(circles[0].getAttribute('r'))) * fit).toBeCloseTo(3)
  expect(rings[0].getAttribute('pointer-events')).toBe('none')
  fireEvent.pointerEnter(circles[0])
  expect(screen.getByText(/Java · updated/)).toBeDefined()
})

it.each([390, 1000])('keeps the dot ring gap at three overview pixels for %s px maps', mapWidth => {
  width = mapWidth
  const { container } = render(<MapView {...props} />)
  const svg = container.querySelector('svg')!
  const dot = container.querySelector('.repo-dot')!
  const ring = container.querySelector('.focus-ring')!
  const gap = (Number(ring.getAttribute('r')) - Number(dot.getAttribute('r'))) * zoomTransform(svg).k
  expect(gap).toBeCloseTo(3)
})

it('moves keyboard focus with arrow-key selection after a dot has focus', () => {
  const { container } = render(<Harness initial={first} />)
  const firstDot = container.querySelector<SVGCircleElement>('.repo-dot[data-full-name="owner/example"]')!
  const secondDot = container.querySelector<SVGCircleElement>('.repo-dot[data-full-name="owner/second"]')!
  firstDot.focus()
  expect(document.activeElement).toBe(firstDot)
  fireEvent.keyDown(firstDot, { key: 'ArrowRight' })
  expect(screen.getByTestId('selected').textContent).toBe(second.full_name)
  expect(document.activeElement).toBe(secondDot)
  expect(firstDot.closest('.repo-point')?.classList.contains('selected')).toBe(false)
  expect(secondDot.closest('.repo-point')?.classList.contains('selected')).toBe(true)
})

it('keeps the focused tooltip anchored to its dot throughout an arrow-key camera pan', () => {
  stubMedia({ compact: false, reduced: false })
  originLeft = 75; originTop = 190
  const { container } = render(<Harness initial={first} />)
  const svg = container.querySelector('svg')!
  const firstDot = container.querySelector<SVGCircleElement>('.repo-dot[data-full-name="owner/example"]')!
  const secondDot = container.querySelector<SVGCircleElement>('.repo-dot[data-full-name="owner/second"]')!
  firstDot.focus()
  fireEvent.keyDown(firstDot, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(secondDot)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.textContent).toContain('second')

  const expectedPosition = () => {
    const camera = zoomTransform(svg)
    const [x, y] = camera.apply([second.x, second.y])
    const radius = Number(secondDot.getAttribute('r')) * camera.k
    return {
      left: `${Math.max(8, Math.min(x + radius + 14, width - 270 - 8))}px`,
      top: `${Math.max(8, Math.min(y - radius + 14, height - 160 - 8))}px`,
    }
  }
  expect(svg.getBoundingClientRect().left).toBe(75)
  expect({ left: tooltip.style.left, top: tooltip.style.top }).toEqual(expectedPosition())
  advanceCameraBy(120)
  expect({ left: tooltip.style.left, top: tooltip.style.top }).toEqual(expectedPosition())
  finishCameraTransition()
  expect({ left: tooltip.style.left, top: tooltip.style.top }).toEqual(expectedPosition())
})

it('uses a cached SVG origin for tooltip pointer moves', () => {
  stubMedia({ compact: false, reduced: true })
  originLeft = 75; originTop = 190
  const { container } = render(<MapView {...props} />)
  const point = container.querySelector<SVGGElement>('.repo-point')!
  const bounds = vi.mocked(SVGSVGElement.prototype.getBoundingClientRect)
  bounds.mockClear()

  fireEvent.pointerEnter(point, { clientX: 100, clientY: 220 })
  expect(bounds).toHaveBeenCalledTimes(1)
  let tooltip = screen.getByRole('tooltip')
  expect({ left: tooltip.style.left, top: tooltip.style.top }).toEqual({ left: '39px', top: '44px' })

  bounds.mockClear()
  fireEvent.pointerMove(point, { clientX: 110, clientY: 230 })
  expect(bounds).not.toHaveBeenCalled()
  tooltip = screen.getByRole('tooltip')
  expect({ left: tooltip.style.left, top: tooltip.style.top }).toEqual({ left: '49px', top: '54px' })
})

it('repositions a clamped tooltip when its observed height changes', () => {
  stubMedia({ compact: false, reduced: true })
  const { container } = render(<MapView {...props} />)
  const point = container.querySelector<SVGGElement>('.repo-point')!
  fireEvent.pointerEnter(point, { clientX: 990, clientY: 690 })
  const tooltip = screen.getByRole('tooltip')
  expect({ left: tooltip.style.left, top: tooltip.style.top, width: tooltip.style.width })
    .toEqual({ left: '722px', top: '532px', width: '270px' })

  reportResize(tooltip, 270, 220)
  expect({ left: tooltip.style.left, top: tooltip.style.top, width: tooltip.style.width })
    .toEqual({ left: '722px', top: '472px', width: '270px' })
})

it('does not zoom when region placement moves the second click onto the SVG ancestor', () => {
  const onRegion = vi.fn()
  const { container } = render(<MapView {...props} onRegion={onRegion} />)
  const svg = container.querySelector('svg')!
  const before = zoomTransform(svg).toString()
  fireEvent.click(screen.getByRole('button', { name: 'Focus region: Developer Tools' }), { detail: 1 })
  act(() => vi.advanceTimersByTime(350))
  fireEvent.doubleClick(svg, { clientX: 400, clientY: 300, detail: 2 })
  expect(onRegion).toHaveBeenCalledTimes(1)
  expect(zoomTransform(svg).toString()).toBe(before)
})

it('renders duplicate wrapped lines without duplicate React keys', () => {
  const repeated = makeAtlas()
  repeated.clusters[0] = { ...repeated.clusters[0], label: 'RepeatedLongWord RepeatedLongWord' }
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const { container } = render(
    <MapView {...props} data={repeated} presentation={atlasPresentation(repeated)} />,
  )
  const lines = [...container.querySelectorAll('.cluster-label tspan')]
  expect(lines.map(line => line.textContent)).toEqual(['RepeatedLongWord', 'RepeatedLongWord'])
  expect(errors.mock.calls.flat().join(' ')).not.toContain('same key')
})

it('keeps D3 synchronized when a label-only refit changes translation but not scale', () => {
  const media = stubMedia({ compact: false, reduced: true })
  const edge = makeRepo({ x: 0, y: 0 })
  const far = makeRepo({ full_name: 'owner/far', name: 'far', x: 1000, y: 1000 })
  const edgeData = makeAtlas([edge, far])
  edgeData.clusters[0] = {
    ...edgeData.clusters[0],
    label: 'Long Developer Tooling Region',
    label_anchor: { x: 0, y: 500 },
  }
  const edgeProps = { ...props, data: edgeData, presentation: atlasPresentation(edgeData), visible: new Set(edgeData.repos.map(repo => repo.full_name)) }
  const { container } = render(<MapView {...edgeProps} />)
  const svg = container.querySelector('svg')!
  const before = zoomTransform(svg)

  media.set({ compact: true })

  const refit = zoomTransform(svg)
  expect(refit.k).toBeCloseTo(before.k)
  expect(refit.x).not.toBeCloseTo(before.x)
  expect(container.querySelector('.map-geometry')?.getAttribute('transform')).toBe(refit.toString())
  mouse(svg, 'mousedown', 400, 300)
  mouse(window, 'mousemove', 420, 300)
  mouse(window, 'mouseup', 420, 300)
  expect(zoomTransform(svg).x - refit.x).toBeCloseTo(20)
})
