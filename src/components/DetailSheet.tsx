import { useEffect, useRef, type ReactNode } from 'react'

export function DetailSheet({ label, onClose, children }: {
  label: string; onClose: () => void; children: ReactNode
}) {
  const dragStart = useRef<number | null>(null)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = panel.current
    if (!node) return
    node.scrollTop = 0
    node.focus({ preventScroll: true })
  }, [label])

  return <aside ref={panel} tabIndex={-1} className="detail-panel populated" aria-label={label}>
    <div className="sheet-handle" aria-hidden="true"
      onPointerDown={event => {
        if (event.pointerType === 'touch') {
          dragStart.current = event.clientY
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }
      }}
      onPointerUp={event => {
        if (event.pointerType === 'touch' && dragStart.current != null && event.clientY - dragStart.current > 80) onClose()
        dragStart.current = null
      }}
      onPointerCancel={() => { dragStart.current = null }} />
    <button className="panel-close" aria-label="Close details" onClick={onClose}>×</button>
    {children}
  </aside>
}
