import type { SuggestionGoal, RepRangeBucket } from 'coachboard-shared'
import { REP_MIDPOINT, GOAL_REP } from './constants'
import type { Step } from './types'

/**
 * Where a generated block starts by default: the coming Monday (today, on a
 * Monday). It used to be today in UTC — so a block generated on a Wednesday
 * started mid-week, and one generated just after midnight started yesterday.
 */
export { nextMonday as defaultStartDate } from '../../lib/dates'

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
