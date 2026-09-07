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

const POSE_STORAGE_KEY = 'coachboard-show-pose'

/**
 * Whether to run pose estimation alongside tracking, remembered across sessions.
 *
 * DEFAULTS OFF, unlike the colour above. Pose costs a 5.8 MB model download on
 * first use and ~32 ms of CPU on every frame the tracker reads — real money for
 * a coach who only wants the bar path, which is what this page was built for.
 * Remembered because the coaches who do want it want it on every clip.
 *
 * It has to be decided BEFORE tracking starts: frames are read once, at playback
 * speed, and the fan-out in captureFrames is set up at the start of that pass.
 * Turning it on afterwards means tracking the clip again.
 */
export function useShowPose(): [boolean, (next: boolean) => void] {
  const [show, setShowState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(POSE_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const setShow = useCallback((next: boolean) => {
    setShowState(next)
    try {
      localStorage.setItem(POSE_STORAGE_KEY, String(next))
    } catch {
      /* not worth surfacing */
    }
  }, [])

  return [show, setShow]
}

/** Same colour at reduced opacity, for the dashed search box. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
