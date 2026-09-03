import { useCallback, useState } from 'react'

// ---------------------------------------------------------------------------
// Overlay colour for the bar path and tracking dot.
//
// Adjustable because there is no single colour that stays readable on real gym
// footage: green vanishes against turf and green flooring, white disappears
// into a bright backlit window, black into a dark platform. The coach can see
// their own video, so they get to pick.
// ---------------------------------------------------------------------------

export interface TrackerColor {
  name: string
  /** Full-strength colour for the dot and the path. */
  value: string
}

export const TRACKER_COLORS: TrackerColor[] = [
  { name: 'Green', value: '#34d399' },
  { name: 'Yellow', value: '#facc15' },
  { name: 'Red', value: '#f43f5e' },
  { name: 'Cyan', value: '#22d3ee' },
  { name: 'Magenta', value: '#e879f9' },
  { name: 'White', value: '#ffffff' },
]

const STORAGE_KEY = 'coachboard-tracker-color'

/**
 * The chosen overlay colour, remembered across sessions.
 *
 * A coach who films in the same gym will want the same colour every time, so
 * re-picking it on each video would be pure friction. Persisted the same way
 * the theme and onboarding state already are.
 */
export function useTrackerColor(): [string, (color: string) => void] {
  const [color, setColorState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? TRACKER_COLORS[0].value
    } catch {
      // Private mode or blocked storage — a default colour is not worth failing over.
      return TRACKER_COLORS[0].value
    }
  })

  const setColor = useCallback((next: string) => {
    setColorState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* not worth surfacing */
    }
  }, [])

  return [color, setColor]
}

/** Same colour at reduced opacity, for the dashed search box. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
