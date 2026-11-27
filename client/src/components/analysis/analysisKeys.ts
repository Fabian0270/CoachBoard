import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Keys on the bar path pages (BP15, D37). No key handling existed on any of
// the three pages; every action needed the mouse. The same principle as the
// program editor (1I): everything by keyboard, everything still by mouse.
//
// A plain key never fires while the coach is typing in a field, or while a
// dialog or menu is open. A button keeps Space and Enter for itself. A
// Ctrl / ⌘ key (Ctrl+S) works from anywhere outside a dialog, as save does
// in every app.
// ---------------------------------------------------------------------------

/** Whether a plain key press is the page's to act on. */
export function keyIsForPage(e: KeyboardEvent): boolean {
  if (document.querySelector('[role="dialog"], [role="menu"]')) return false
  if (e.ctrlKey || e.metaKey) return true
  const t = e.target as HTMLElement | null
  if (!t || t === document.body || t === document.documentElement) return true
  // The video's own controls would seek 5 s on an arrow; ours step a frame.
  if (t instanceof HTMLVideoElement) return true
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return false
  if (tag === 'BUTTON' || tag === 'A') return e.key !== ' ' && e.key !== 'Enter'
  return true
}

/**
 * Listen for keys while `enabled`. `onKey` returns true when it acted, which
 * stops the browser's own handling (scrolling on Space, the video seeking).
 */
export function useAnalysisKeys(enabled: boolean, onKey: (e: KeyboardEvent) => boolean) {
  const ref = useRef(onKey)
  ref.current = onKey
  useEffect(() => {
    if (!enabled) return
    const handle = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !keyIsForPage(e)) return
      if (ref.current(e)) e.preventDefault()
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [enabled])
}

/** A plain letter or digit key, case-insensitive, with no Ctrl / ⌘. */
export const plainKey = (e: KeyboardEvent, key: string) => !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === key
