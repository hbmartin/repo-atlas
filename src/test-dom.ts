import { act } from '@testing-library/react'
import { vi } from 'vitest'
import { COMPACT_MEDIA_QUERY, MAP_TRANSITION_DURATION, REDUCED_MOTION_MEDIA_QUERY } from './view-utils'

type MediaSettings = { compact: boolean; reduced: boolean }

export function stubMedia(initial: MediaSettings) {
  const settings = { ...initial }
  const listeners = new Map<string, Set<() => void>>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === COMPACT_MEDIA_QUERY ? settings.compact
        : query === REDUCED_MOTION_MEDIA_QUERY ? settings.reduced : false
    },
    addEventListener(type: string, listener: () => void) {
      if (type !== 'change') return
      const queryListeners = listeners.get(query) ?? new Set()
      queryListeners.add(listener)
      listeners.set(query, queryListeners)
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === 'change') listeners.get(query)?.delete(listener)
    },
  }))
  return {
    set(next: Partial<MediaSettings>) {
      Object.assign(settings, next)
      act(() => {
        for (const queryListeners of listeners.values()) {
          for (const listener of queryListeners) listener()
        }
      })
    },
  }
}

export const CAMERA_FRAME_MS = 20
// d3-timer retains its scheduler across tests, so this clock must stay monotonic.
let cameraNow = 0

export function installCameraClock() {
  vi.spyOn(performance, 'now').mockImplementation(() => cameraNow)
}

export function advanceCameraBy(duration: number) {
  for (let elapsed = 0; elapsed < duration; elapsed += CAMERA_FRAME_MS) {
    const step = Math.min(CAMERA_FRAME_MS, duration - elapsed)
    cameraNow += step
    act(() => vi.advanceTimersByTime(step))
  }
}

export function finishCameraTransition() {
  advanceCameraBy(MAP_TRANSITION_DURATION + CAMERA_FRAME_MS)
}
