import type { SuggestionGoal, RepRangeBucket } from 'coachboard-shared'
import { REP_MIDPOINT, GOAL_REP } from './constants'
import type { Step } from './types'

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export const clampDays = (n: number): 3 | 4 | 5 => (n <= 3 ? 3 : n >= 5 ? 5 : 4)

export function repBiasFor(goal: SuggestionGoal, bucket: RepRangeBucket | null): number {
  if (!bucket) return 0
  const raw = Math.round((REP_MIDPOINT[bucket] - GOAL_REP[goal]) / 3)
  return Math.max(-2, Math.min(2, raw))
}

export function firstStep(programId?: string, athleteId?: string): Step {
  if (programId) return 'goal'
  if (athleteId) return 'source'
  return 'athlete'
}
