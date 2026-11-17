import { useSyncExternalStore } from 'react'
import type { PenTool } from './annotations'

// ---------------------------------------------------------------------------
// Which shape the pen draws (BP30), shared by the pen's controls and every
// stage, so picking Arrow in the controls is what the next drag draws —
// without threading it through each page. Starts as freehand each session.
// ---------------------------------------------------------------------------

let current: PenTool = 'free'
const listeners = new Set<() => void>()

export function setPenTool(next: PenTool) {
  if (next === current) return
  current = next
  for (const l of listeners) l()
}

export function usePenTool(): [PenTool, (next: PenTool) => void] {
  const tool = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
  return [tool, setPenTool]
}
