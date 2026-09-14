// @vitest-environment jsdom
import { zoomTransform } from 'd3-zoom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAtlas } from '../test-fixtures'
import type { ViewState } from '../types'
import {
  COMPACT_MEDIA_QUERY,
  mobileMapTargetY,
  nearestRepoAtPoint,
  pointerToMapPoint,
} from '../view-utils'
import { MapView } from './MapView'
import { atlasPresentation } from '../presentation'

const view: ViewState = { repo: null, languages: [], regions: [], since: null, layoutAlt: false }
const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)'

function stubMedia({ compact, reduced }: { compact: boolean; reduced: boolean }) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === COMPACT_MEDIA_QUERY ? compact : query === REDUCED_MOTION_MEDIA_QUERY ? reduced : false,
    addEventListener() {},
    removeEventListener() {},
  }))
}

async function finishTransition() {
  await act(() => new Promise(resolve => setTimeout(resolve, 300)))
}

beforeEach(() => {
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0, toJSON() {} })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  stubMedia({ compact: true, reduced: true })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('MapView', () => {
  it('chooses the geometrically nearest repository in overlapping hit areas', () => {
    const first = makeAtlas().repos[0]
    const second = { ...first, full_name: 'owner/second', name: 'second', x: 515 }
    const visible = new Set([first.full_name, second.full_name])
    expect(nearestRepoAtPoint([first, second], visible, 501, 500, 22, false)).toBe(first)
    expect(nearestRepoAtPoint([first, second], visible, 514, 500, 22, false)).toBe(second)
  })

  it('hits the full drawn radius without masking a closer repo with the selection', () => {
    const selected = makeAtlas().repos[0]
    const neighbor = { ...selected, full_name: 'owner/neighbor', name: 'neighbor', x: 524 }
    const visible = new Set([selected.full_name, neighbor.full_name])
    const radius = (repo: typeof selected) => repo.full_name === selected.full_name ? 30 : 6
    expect(nearestRepoAtPoint(
      [selected, neighbor], visible, 525, 500, 5, false, radius, selected.full_name,
    )).toBe(neighbor)
  })

  it('uses the selected repository only to break an exact distance tie', () => {
    const selected = makeAtlas().repos[0]
    const neighbor = { ...selected, full_name: 'owner/neighbor', name: 'neighbor', x: 510 }
    const visible = new Set([selected.full_name, neighbor.full_name])
    expect(nearestRepoAtPoint(
      [neighbor, selected], visible, 505, 500, 10, false, () => 0, selected.full_name,
    )).toBe(selected)
  })

  it('prefers the drawn selected circle over a neighbors padded target', () => {
    const selected = makeAtlas().repos[0]
    const neighbor = { ...selected, full_name: 'owner/neighbor', x: 522 }
    const visible = new Set([selected.full_name, neighbor.full_name])
    for (const repos of [[selected, neighbor], [neighbor, selected]]) {
      expect(nearestRepoAtPoint(
        repos, visible, 516, 500, 22, false,
        (repo) => repo.full_name === selected.full_name ? 18 : 3, selected.full_name,
      )).toBe(selected)
      expect(nearestRepoAtPoint(
        repos, visible, 522, 500, 22, false,
        (repo) => repo.full_name === selected.full_name ? 18 : 3, selected.full_name,
      )).toBe(neighbor)
    }
  })

  it('never renders overview descriptions', () => {
    const data = makeAtlas()
    const { container } = render(<MapView data={data} presentation={atlasPresentation(data)} view={view} visible={new Set([data.repos[0].full_name])} selected={null} onSelect={vi.fn()} />)
    expect(container.querySelector('.cluster-gloss')).toBeNull()
    expect(container.textContent).not.toContain(data.clusters[0].gloss)
    expect(container.querySelector('.map-grid')).toBeNull()
  })

  it('uses map-level hit testing instead of overlapping transparent circles', () => {
    const data = makeAtlas()
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const { container } = render(
      <MapView data={data} presentation={atlasPresentation(data)} view={view} visible={new Set([data.repos[0].full_name])} selected={null} onSelect={onSelect} />,
    )
    const svg = container.querySelector('svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000,
      x: 0, y: 0, toJSON: () => ({}),
    })
    const [clientX, clientY] = zoomTransform(svg).apply([500, 500])
    fireEvent.pointerDown(svg, { clientX, clientY })
    fireEvent.click(svg, { clientX, clientY, detail: 1 })
    expect(container.querySelector('.touch-target')).toBeNull()
    act(() => vi.advanceTimersByTime(300))
    expect(onSelect).toHaveBeenCalledWith(data.repos[0], expect.objectContaining({ clickToken: expect.any(Number) }))
  })

  it('centers selected repositories in the visible map area above the mobile sheet', () => {
    expect(mobileMapTargetY({ left: 0, top: 176, width: 390, height: 668 }, 338)).toBe(81)
    expect(mobileMapTargetY({ left: 0, top: 0, width: 800, height: 800 }, 480)).toBe(240)
    expect(pointerToMapPoint(
      195,
      176,
      { left: 0, top: 176, width: 390, height: 668 },
      { x: 0, y: 0, k: 1 },
    ).y).toBe(0)
  })

  it('zooms by 1.25 and resets to fit without changing selection or filters', () => {
    const data = makeAtlas()
    const onSelect = vi.fn()
    const { container, rerender } = render(<MapView data={data} presentation={atlasPresentation(data)} view={view} visible={new Set([data.repos[0].full_name])} selected={null} onSelect={onSelect} />)
    const initial = container.querySelector('.map-geometry')!.getAttribute('transform')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByLabelText('Zoom level').textContent).toBe('125%')
    const zoomed = container.querySelector('.map-geometry')!.getAttribute('transform')
    rerender(<MapView data={data} presentation={atlasPresentation(data)} view={{ ...view, languages: ['Other'] }} visible={new Set()} selected={null} onSelect={onSelect} />)
    expect(container.querySelector('.map-geometry')!.getAttribute('transform')).toBe(zoomed)
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    expect(container.querySelector('.map-geometry')!.getAttribute('transform')).toBe(initial)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('100%')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('completes animated HUD zooms and reset when reduced motion is off', async () => {
    stubMedia({ compact: false, reduced: false })
    const data = makeAtlas()
    const { container } = render(<MapView data={data} presentation={atlasPresentation(data)} view={view} visible={new Set([data.repos[0].full_name])} selected={null} onSelect={vi.fn()} />)
    const svg = container.querySelector('svg')!
    const initial = zoomTransform(svg)

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await finishTransition()
    expect(zoomTransform(svg).k / initial.k).toBeCloseTo(1.25)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('125%')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    await finishTransition()
    expect(zoomTransform(svg).k).toBeCloseTo(initial.k)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('100%')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await finishTransition()
    expect(zoomTransform(svg).k / initial.k).toBeCloseTo(1.25)
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    await finishTransition()
    const reset = zoomTransform(svg)
    expect(reset.x).toBeCloseTo(initial.x)
    expect(reset.y).toBeCloseTo(initial.y)
    expect(reset.k).toBeCloseTo(initial.k)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('100%')
  })

  it('double-clicks to zoom around the pointer without selecting a repository', () => {
    const data = makeAtlas()
    const onSelect = vi.fn()
    const { container } = render(<MapView data={data} presentation={atlasPresentation(data)} view={view} visible={new Set([data.repos[0].full_name])} selected={null} onSelect={onSelect} />)
    const svg = container.querySelector('svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700,
      x: 0, y: 0, toJSON: () => ({}),
    })
    const pointer: [number, number] = [725, 275]
    const initial = zoomTransform(svg)
    const point = initial.invert(pointer)

    fireEvent.doubleClick(svg, { clientX: pointer[0], clientY: pointer[1], detail: 2 })

    const zoomed = zoomTransform(svg)
    expect(zoomed.k).toBeCloseTo(initial.k * 2)
    expect(zoomed.apply(point)[0]).toBeCloseTo(pointer[0])
    expect(zoomed.apply(point)[1]).toBeCloseTo(pointer[1])
    expect(onSelect).not.toHaveBeenCalled()

    for (let index = 0; index < 8; index += 1) {
      fireEvent.doubleClick(svg, { clientX: pointer[0], clientY: pointer[1], detail: 2 })
    }
    expect(zoomTransform(svg).k).toBeCloseTo(initial.k * 10)
  })

  it('completes animated double-click zoom around the pointer when reduced motion is off', async () => {
    stubMedia({ compact: false, reduced: false })
    const data = makeAtlas()
    const onSelect = vi.fn()
    const { container } = render(<MapView data={data} presentation={atlasPresentation(data)} view={view} visible={new Set([data.repos[0].full_name])} selected={null} onSelect={onSelect} />)
    const svg = container.querySelector('svg')!
    const pointer: [number, number] = [725, 275]
    const initial = zoomTransform(svg)
    const point = initial.invert(pointer)

    fireEvent.doubleClick(svg, { clientX: pointer[0], clientY: pointer[1], detail: 2 })
    await finishTransition()

    const zoomed = zoomTransform(svg)
    expect(zoomed.k).toBeCloseTo(initial.k * 2)
    expect(zoomed.apply(point)[0]).toBeCloseTo(pointer[0])
    expect(zoomed.apply(point)[1]).toBeCloseTo(pointer[1])
    expect(screen.getByLabelText('Zoom level').textContent).toBe('200%')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('preserves an explicit region fit through the resize caused by wrapping filter counts', () => {
    let width = 390, height = 670
    let resize: (() => void) | undefined
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
    const bounds = vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: 170, width, height, right: width, bottom: height + 170, x: 0, y: 170, toJSON() {} }))
    const first = makeAtlas().repos[0]
    const data = makeAtlas([{ ...first, x: 100, y: 100 }, { ...first, full_name: 'owner/far', x: 900, y: 900, cluster_id: 1 }])
    data.clusters.push({ ...data.clusters[0], id: 1, label: 'Far Away' })
    const props = { data, presentation: atlasPresentation(data), view, visible: new Set(data.repos.map(repo => repo.full_name)), selected: null, onSelect: vi.fn() }
    const { rerender } = render(<MapView {...props} />)
    rerender(<MapView {...props} navigationRequest={{ kind: 'region', target: 'Developer Tools', nonce: 1 }} />)
    expect(screen.getByLabelText('Zoom level').textContent).toBe('400%')
    height = 655
    act(() => resize?.())
    expect(screen.getByLabelText('Zoom level').textContent).toBe('400%')
    width = 768
    act(() => resize?.())
    expect(screen.getByLabelText('Zoom level').textContent).toBe('400%')
    bounds.mockRestore()
  })

  it('closes details with Escape even after focus moves outside the map', () => {
    const data = makeAtlas()
    const onSelect = vi.fn()
    render(
      <MapView
        data={data}
        presentation={atlasPresentation(data)}
        view={{ ...view, repo: data.repos[0].full_name }}
        visible={new Set([data.repos[0].full_name])}
        selected={data.repos[0]}
        onSelect={onSelect}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('navigates spatially between visible repositories with the arrow keys', () => {
    const first = makeAtlas().repos[0]
    const second = { ...first, full_name: 'owner/right', name: 'right', x: 700, x_alt: 700 }
    const data = makeAtlas([first, second])
    const onSelect = vi.fn()
    render(
      <MapView
        data={data}
        presentation={atlasPresentation(data)}
        view={{ ...view, repo: first.full_name }}
        visible={new Set(data.repos.map((repo) => repo.full_name))}
        selected={first}
        onSelect={onSelect}
      />,
    )
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith(second)
  })

  it('leaves vertical arrow keys available for scrolling the focused details panel', () => {
    const first = makeAtlas().repos[0]
    const below = { ...first, full_name: 'owner/below', name: 'below', y: 700, y_alt: 700 }
    const data = makeAtlas([first, below])
    const onSelect = vi.fn()
    render(
      <MapView
        data={data}
        presentation={atlasPresentation(data)}
        view={{ ...view, repo: first.full_name }}
        visible={new Set(data.repos.map((repo) => repo.full_name))}
        selected={first}
        onSelect={onSelect}
      />,
    )
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
