// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAtlas } from '../test-fixtures'
import type { ViewState } from '../types'
import {
  clusterGlossesVisible,
  clusterLabelX,
  mobileMapTargetY,
  nearestRepoAtPoint,
  pointerToMapPoint,
} from '../view-utils'
import { MapView } from './MapView'

const view: ViewState = { repo: null, languages: [], regions: [], since: null, layoutAlt: false }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MapView', () => {
  it('keeps region labels inside the map bounds', () => {
    expect(clusterLabelX(20, 'Android and Kotlin', '', false)).toBeGreaterThan(20)
    expect(clusterLabelX(980, 'Undocumented Projects', '', false)).toBeLessThan(980)
    expect(clusterLabelX(500, 'Developer Tools', '', false)).toBe(500)
  })

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

  it('shows region glosses on ordinary desktop maps', () => {
    expect(clusterGlossesVisible(1, 800)).toBe(true)
    expect(clusterGlossesVisible(1, 600)).toBe(false)
    expect(clusterGlossesVisible(2, 800)).toBe(false)
    expect(clusterGlossesVisible(1, 800, true)).toBe(false)
    expect(clusterLabelX(80, 'AI', 'A'.repeat(100), clusterGlossesVisible(1, 800, true))).toBe(80)
  })

  it('omits invisible tablet glosses and their positioning space', () => {
    const data = makeAtlas()
    data.clusters[0].label = 'AI'
    data.clusters[0].label_anchor.x = 80
    data.clusters[0].gloss = 'A'.repeat(100)
    const { container } = render(
      <MapView data={data} view={view} visible={new Set(data.repos.map((repo) => repo.full_name))}
        selected={null} onSelect={vi.fn()} />,
    )
    expect(container.querySelector('.cluster-gloss')).toBeNull()
    expect(container.querySelector('.cluster-label')?.getAttribute('transform')).toContain('translate(80 ')
  })

  it('uses map-level hit testing instead of overlapping transparent circles', () => {
    const data = makeAtlas()
    const onSelect = vi.fn()
    const { container } = render(
      <MapView data={data} view={view} visible={new Set([data.repos[0].full_name])} selected={null} onSelect={onSelect} />,
    )
    const svg = container.querySelector('svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000,
      x: 0, y: 0, toJSON: () => ({}),
    })
    fireEvent.pointerDown(svg, { clientX: 510, clientY: 500 })
    fireEvent.click(svg, { clientX: 510, clientY: 500, detail: 1 })
    expect(container.querySelector('.touch-target')).toBeNull()
    expect(onSelect).toHaveBeenCalledWith(data.repos[0])
  })

  it('centers selected repositories in the visible map area above the mobile sheet', () => {
    expect(mobileMapTargetY({ left: 0, top: 176, width: 390, height: 668 }, 338)).toBeCloseTo(207.69, 1)
    expect(mobileMapTargetY({ left: 0, top: 0, width: 800, height: 800 }, 480)).toBe(300)
    expect(pointerToMapPoint(
      195,
      176,
      { left: 0, top: 176, width: 390, height: 668 },
      { x: 0, y: 0, k: 1 },
    ).y).toBe(0)
  })

  it('closes details with Escape even after focus moves outside the map', () => {
    const data = makeAtlas()
    const onSelect = vi.fn()
    render(
      <MapView
        data={data}
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
