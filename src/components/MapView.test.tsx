// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAtlas } from '../test-fixtures'
import type { ViewState } from '../types'
import { clusterLabelX, mobileMapTargetY, nearestRepoAtPoint, pointerToMapPoint } from '../view-utils'
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
})
