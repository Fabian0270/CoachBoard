// Where the cursor goes back to when a dialog opened from a menu closes.
//
// A menu item that opens a dialog is gone by the time the dialog opens, so
// the dialog had nothing to put the cursor back on and it fell to the top of
// the page. The item notes the button that opened its menu; a dialog opening
// right after takes that button instead.

let last: { trigger: HTMLElement; at: number } | null = null

/** Called by a menu item as it is chosen. */
export function rememberMenuTrigger(item: Element): void {
  // Never in the way of the item itself: whatever happens here, its action runs.
  try {
    const id = item.closest('[role="menu"]')?.id
    const trigger = id
      ? [...document.querySelectorAll<HTMLElement>('[aria-controls]')].find((el) => el.getAttribute('aria-controls') === id) ?? null
      : null
    last = trigger ? { trigger, at: Date.now() } : null
  } catch {
    last = null
  }
}

/** The button of a menu item chosen just now, if it is still on the page. */
export function recentMenuTrigger(withinMs = 1000): HTMLElement | null {
  if (!last || Date.now() - last.at > withinMs || !last.trigger.isConnected) return null
  return last.trigger
}
