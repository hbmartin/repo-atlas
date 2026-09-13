// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAtlas } from './test-fixtures'
import App from './App'

vi.mock('./components/MapView', () => ({ MapView: () => <div>Map fixture</div> }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => makeAtlas(),
  }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})
afterEach(() => {
  cleanup()
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
})
