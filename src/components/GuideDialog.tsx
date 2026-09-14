import { useEffect, useRef, type ReactNode } from 'react'

export function GuideDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    dialog.showModal()
    return () => { dialog.close(); previous?.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={ref} className="guide-dialog" aria-label="Atlas guide" onClose={event => { if (!event.currentTarget.open) onClose() }} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <button className="guide-close" onClick={onClose} aria-label="Close atlas guide">Close ×</button>
    {children}
  </dialog>
}
