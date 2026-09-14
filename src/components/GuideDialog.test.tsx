// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GuideDialog } from './GuideDialog'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

it('ignores Strict Mode cleanup close events after reopening and restores prior focus', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const onClose = vi.fn()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = true
    this.querySelector<HTMLButtonElement>('button')?.focus()
  } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = false
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  } })
  const { unmount } = render(<StrictMode><GuideDialog onClose={onClose}>Guide contents</GuideDialog></StrictMode>)
  await act(async () => { await Promise.resolve() })
  expect((screen.getByRole('dialog') as HTMLDialogElement).open).toBe(true)
  expect(onClose).not.toHaveBeenCalled()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(onClose).toHaveBeenCalledTimes(1)
  unmount()
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})
