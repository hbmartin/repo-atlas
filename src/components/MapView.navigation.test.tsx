// @vitest-environment jsdom
import { useMemo, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zoomTransform } from 'd3-zoom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AtlasRepo, MapNavigationRequest, ViewState } from '../types'
import { atlasPresentation } from '../presentation'
import { makeAtlas, makeRepo } from '../test-fixtures'
import { MapView } from './MapView'

const empty: ViewState = { repo: null, languages: [], regions: [], since: null, layoutAlt: false }
const first = makeRepo({ x: 200, y: 200, x_alt: 250, y_alt: 250 })
const second = makeRepo({ full_name: 'owner/second', name: 'second', x: 700, y: 600, x_alt: 650, y_alt: 550, cluster_id: 1 })
const data = makeAtlas([first, second])
data.clusters[0] = { ...data.clusters[0], label_anchor: { x: 200, y: 200 }, contours: { outer: [[[100, 100], [300, 100], [300, 300], [100, 300]]], inner: [] } }
data.clusters.push({ ...data.clusters[0], id: 1, label: 'Second Region', label_anchor: { x: 700, y: 600 }, contours: { outer: [[[600, 500], [800, 500], [800, 700], [600, 700]]], inner: [] } })
const presentation = atlasPresentation(data)
const props = { data, presentation, view: empty, visible: new Set(data.repos.map(repo => repo.full_name)), selected: null, onSelect: vi.fn() }
let width = 1000, height = 700
let resize: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  width = 1000; height = 700
  resize = undefined
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() {} }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

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

it('renders supplied colors and a neutral fallback without renaming repositories', () => {
  const custom = makeAtlas([makeRepo({ primary_language: 'Gleam' }), makeRepo({ full_name: 'owner/unknown', primary_language: 'Unlisted' })])
  custom.languages = [{ name: 'Gleam', count: 1, color: '#abcdef' }]
  const { container } = render(<MapView {...props} data={custom} presentation={atlasPresentation(custom)} />)
  const circles = container.querySelectorAll('.repo-point circle')
  expect(circles[0].getAttribute('fill')).toBe('#abcdef')
  expect(circles[1].getAttribute('fill')).toBe('#87909e')
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
