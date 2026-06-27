import type { SuggestionGoal, RepRangeBucket } from 'coachboard-shared'

export const GOAL_LABELS: Record<SuggestionGoal, string> = {
  hypertrophy: 'Hypertrophy',
  strength: 'Strength',
  peaking: 'Peaking',
}
export const GOAL_DESCRIPTIONS: Record<SuggestionGoal, string> = {
  hypertrophy: 'Higher volume, moderate intensity — builds the muscle base that supports heavier lifting.',
  strength: 'Moderate reps, rising intensity — develops force production through the competition lifts.',
  peaking: 'Low volume, high intensity — prepares the athlete to express maximum strength on a test or meet day.',
}

export const TRAINING_DAY_OPTIONS = [3, 4, 5] as const

// Representative rep for a learned bucket vs. a goal's natural rep target — used
// to derive a gentle (±2) rep nudge toward how the coach usually programs.
export const REP_MIDPOINT: Record<RepRangeBucket, number> = { '1-3': 2, '4-6': 5, '6-10': 8, '10+': 11 }
export const GOAL_REP: Record<SuggestionGoal, number> = { hypertrophy: 8, strength: 4, peaking: 2 }
