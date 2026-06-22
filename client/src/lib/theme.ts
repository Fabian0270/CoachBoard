export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'coachboard-theme'

const prefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

export function getStoredTheme(): Theme {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

/** Resolve a theme preference to the actual mode that should be shown. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme
}

/** Toggle the `dark` class on <html> to match the given preference. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolveTheme(theme) === 'dark')
}

/** Persist the preference and apply it immediately. */
export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

/**
 * Keep the document in sync with OS theme changes while the stored
 * preference is `system`. Returns an unsubscribe function.
 */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (getStoredTheme() === 'system') applyTheme('system')
  }
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}
