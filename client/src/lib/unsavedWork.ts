import { useEffect } from 'react'

// ---------------------------------------------------------------------------
// Work that would be lost if the window closed now.
//
// Closing CoachBoard mid-recording, mid-upload or with program edits that had
// not saved used to just close it, and the work was gone without a word. Any
// screen with such work registers it here; while anything is registered the
// page asks not to be unloaded, and the Electron main process turns that into
// a "close anyway?" dialog (see will-prevent-unload in electron/src/main.ts).
// ---------------------------------------------------------------------------

const active = new Set<string>()

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (active.size === 0) return
  event.preventDefault()
  // Older engines need returnValue set as well.
  event.returnValue = ''
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload)

/** Whether anything is registered. Exported for tests. */
export function hasUnsavedWork(): boolean {
  return active.size > 0
}

/** Registers `key` while `isActive` is true, and releases it when not or on unmount. */
export function useUnsavedWork(key: string, isActive: boolean): void {
  useEffect(() => {
    if (!isActive) return
    active.add(key)
    return () => {
      active.delete(key)
    }
  }, [key, isActive])
}
