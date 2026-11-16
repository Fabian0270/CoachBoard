import { useEffect, useRef } from 'react'

/**
 * Keyboard for the app's hand-built drop-down menus: when the menu opens the
 * first item takes focus, Up / Down (and Home / End) move between items, Esc
 * and Tab close it, and focus goes back to the button that opened it.
 *
 * Before this the menus could only be used with the mouse: they opened with
 * the cursor still on their button and the arrow keys did nothing.
 */
export function useMenuKeys(open: boolean, close: () => void) {
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    items()[0]?.focus()
    const menu = menuRef.current
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      const list = items()
      const at = list.indexOf(document.activeElement as HTMLElement)
      const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus() }
      if (e.key === 'ArrowDown') go(at + 1)
      else if (e.key === 'ArrowUp') go(at - 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(list.length - 1)
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); triggerRef.current?.focus() }
      else if (e.key === 'Tab') closeRef.current()
    }
    menu.addEventListener('keydown', onKey)
    return () => menu.removeEventListener('keydown', onKey)
  }, [open])

  return { menuRef, triggerRef }
}
