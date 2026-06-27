import type { ExternalExerciseRow, SuggestionGoal } from 'coachboard-shared'

// ---------------------------------------------------------------------------
// Focus heuristic — pre-select the import wizard's focus dropdown from the
// parsed rep/RPE data (the coach always confirms).
// ---------------------------------------------------------------------------

/** First number in a reps cell ("5", "3-5", "3–5") → the lower bound, or null. */
function repsLowerBound(reps: string | null): number | null {
  if (!reps) return null
  const m = reps.match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Best-guess training focus from the parsed rows — pre-selects the focus
 * dropdown in the import wizard (the coach always confirms). Uses the median
 * rep target, with a high final-week RPE nudging a borderline block to peaking.
 * Returns null when no numeric reps are present to judge from.
 */
export function guessFocus(exercises: ExternalExerciseRow[]): SuggestionGoal | null {
  const reps = exercises
    .map((e) => repsLowerBound(e.reps))
    .filter((n): n is number => n !== null)
  if (reps.length === 0) return null

  const medReps = median(reps)

  // Average RPE in the final week (when RPE was parsed) — a near-maximal finish
  // on a low-rep block is the signature of a peak.
  const maxWeek = Math.max(...exercises.map((e) => e.weekIndex))
  const finalRpes = exercises
    .filter((e) => e.weekIndex === maxWeek && e.rpe)
    .map((e) => parseFloat(e.rpe!.replace(',', '.')))
    .filter((n) => !isNaN(n))
  const finalAvgRpe = finalRpes.length ? finalRpes.reduce((a, b) => a + b, 0) / finalRpes.length : null

  if (medReps <= 3) return 'peaking'
  if (medReps <= 6) return finalAvgRpe !== null && finalAvgRpe >= 9 ? 'peaking' : 'strength'
  return 'hypertrophy'
}
