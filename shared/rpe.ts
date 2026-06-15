// RPE → %1RM conversion based on the Tuchscherer/RTS chart.
//
// The chart is diagonal: doing one more rep at the same RPE costs the same
// percentage as keeping the reps and dropping one full RPE point. That lets
// the whole table collapse into one sequence indexed by
// (reps - 1) + (10 - RPE), in half-step increments.

export const RPE_VALUES = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const
export type RpeValue = (typeof RPE_VALUES)[number]

export const MIN_REPS = 1
export const MAX_REPS = 10

/** %1RM at index n half-steps below a 1-rep max effort (index 0 = 1 @ RPE 10). */
const PCT_SEQUENCE = [
  100, 97.8, 95.5, 93.9, 92.2, 90.7, 89.2, 87.8, 86.3, 85.0,
  83.7, 82.4, 81.1, 79.9, 78.6, 77.4, 76.2, 75.1, 73.9, 72.3,
  70.7, 69.4, 68.0, 66.7, 65.3, 64.0,
]

function isValidRpe(rpe: number): boolean {
  return rpe >= 5 && rpe <= 10 && Number.isInteger(rpe * 2)
}

/**
 * Fraction of 1RM (0–1) for `reps` at `rpe`, e.g. pctOf1RM(5, 8) === 0.811.
 * Returns null outside the chart (reps 1–10, RPE 5–10 in half steps).
 * Note: for RPE 5–6, very high rep counts (9–10 reps) exceed the published
 * chart and also return null.
 */
export function pctOf1RM(reps: number, rpe: number): number | null {
  if (!Number.isInteger(reps) || reps < MIN_REPS || reps > MAX_REPS) return null
  if (!isValidRpe(rpe)) return null
  const index = Math.round(2 * (reps - 1) + 2 * (10 - rpe))
  const pct = PCT_SEQUENCE[index]
  return pct === undefined ? null : pct / 100
}

/**
 * Estimated 1RM from a performed set, e.g. estimate1RM(150, 5, 8) ≈ 185.
 * Returns null when the set falls outside the chart.
 */
export function estimate1RM(weight: number, reps: number, rpe: number): number | null {
  if (!Number.isFinite(weight) || weight <= 0) return null
  const pct = pctOf1RM(reps, rpe)
  return pct ? weight / pct : null
}

/**
 * Prescribed weight for `reps` at `rpe` given a 1RM, rounded to `increment`
 * (default 2.5 kg), e.g. targetWeight(200, 5, 8) === 162.5.
 */
export function targetWeight(oneRM: number, reps: number, rpe: number, increment = 2.5): number | null {
  if (!Number.isFinite(oneRM) || oneRM <= 0) return null
  if (!Number.isFinite(increment) || increment <= 0) return null
  const pct = pctOf1RM(reps, rpe)
  if (!pct) return null
  return Math.round((oneRM * pct) / increment) * increment
}
