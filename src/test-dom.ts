import { act } from '@testing-library/react'
import { vi } from 'vitest'
import { COMPACT_MEDIA_QUERY, MAP_TRANSITION_DURATION, REDUCED_MOTION_MEDIA_QUERY } from './view-utils'

type MediaSettings = { compact: boolean; reduced: boolean }

type ResizeRegistration = { callback: ResizeObserverCallback; observer: ResizeObserver; targets: Set<Element> }

export function stubScrollIntoView() {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  const mock = vi.fn()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: mock })
  return {
    mock,
    restore() {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original)
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    },
  }
}

export function stubResizeObserver() {
  const registrations: ResizeRegistration[] = []
  vi.stubGlobal('ResizeObserver', class {
    private registration: ResizeRegistration
    constructor(callback: ResizeObserverCallback) {
      this.registration = { callback, observer: this as unknown as ResizeObserver, targets: new Set() }
      registrations.push(this.registration)
    }
    observe(target: Element) { this.registration.targets.add(target) }
    unobserve(target: Element) { this.registration.targets.delete(target) }
    disconnect() { this.registration.targets.clear() }
  })
  const registrationFor = (target: Element) => {
    const registration = registrations.find(item => item.targets.has(target))
    if (!registration) throw new Error('Element is not observed')
    return registration
  }
  const notify = (target: Element, entry?: ResizeObserverEntry) => {
    const registration = registrationFor(target)
    act(() => registration.callback(entry ? [entry] : [], registration.observer))
  }
  return {
    notify,
    report(target: Element, width: number, height: number, box: 'array' | 'single' | 'missing' = 'array') {
      const raw = { target } as unknown as ResizeObserverEntry
      if (box !== 'missing') {
        const size = { inlineSize: width, blockSize: height } as ResizeObserverSize
        Object.defineProperty(raw, 'borderBoxSize', { value: box === 'array' ? [size] : size })
      }
      notify(target, raw)
    },
    observerCount() { return registrations.length },
  }
}

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
let cameraNow = 0

export function installCameraClock() {
  cameraNow = 0
  vi.useFakeTimers({ toNotFake: ['performance'] })
  vi.spyOn(performance, 'now').mockImplementation(() => cameraNow)
}

export function uninstallCameraClock() {
  vi.clearAllTimers()
  vi.useRealTimers()
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
