import { targetWeight } from 'coachboard-shared/rpe'
import { bestStoredMax, mainLiftKey } from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// A suggested load for one exercise, from the athlete's stored max.
//
// A hint and nothing more: the day editor shows it in the empty Load Cap
// cell and fills it in only when the coach takes it. The coach's
// programming always wins (see the knowledge base's "support, never
// override"). It exists because the RPE cheat sheet that answers "what is
// 5 @ RPE 8 for her?" lives on the athlete page, two screens away from the
// day being written.
// ---------------------------------------------------------------------------

export interface StoredMax {
  lift_name: string
  weight: number
  recorded_at: string
}

export interface LoadHint {
  kg: number
  /** How it was worked out, for the tooltip: "RPE 8 × 5 reps of a 180 kg max". */
  basis: string
}

const num = (s: string) => Number(s.replace(',', '.'))

/** The target in an Intensity cell: an RPE, or a percentage of 1RM. Ranges give their middle. */
export function parseTarget(intensity: string | null | undefined): { rpe: number } | { pct: number } | null {
  const text = (intensity ?? '').trim()
  if (!text) return null
  const range = '(\\d+(?:[.,]\\d+)?)(?:\\s*[-–]\\s*(\\d+(?:[.,]\\d+)?))?'
  const mid = (m: RegExpMatchArray) => (m[2] ? (num(m[1]) + num(m[2])) / 2 : num(m[1]))

  const pct = text.match(new RegExp(`${range}\\s*%`))
  if (pct) {
    const v = mid(pct)
    return v > 0 && v <= 110 ? { pct: v } : null
  }
  // "RPE 8", "@8", "rpe8.5", or a bare number/range filling the cell ("8", "7-8").
  const rpe = text.match(new RegExp(`(?:rpe\\s*|@\\s*)${range}`, 'i')) ?? text.match(new RegExp(`^${range}$`))
  if (rpe) {
    const v = Math.round(mid(rpe) * 2) / 2
    return v >= 5 && v <= 10 ? { rpe: v } : null
  }
  return null
}

/**
 * Reps to plan the load for. A range ("8-10") uses its top end, the lighter
 * load: a hint that errs, errs light.
 */
export function parseReps(reps: string | null | undefined): number | null {
  const m = (reps ?? '').match(/(\d+)(?:\s*[-–]\s*(\d+))?/)
  if (!m) return null
  const n = Number(m[2] ?? m[1])
  return n > 0 ? n : null
}

/**
 * The max that belongs to this exercise: one stored under exactly its name
 * first (a "Pause Squat" max for pause squats), otherwise the competition
 * lift's when the app's shared matcher counts the exercise as one.
 */
export function maxFor(exerciseName: string, maxes: StoredMax[]): StoredMax | null {
  const want = exerciseName.trim().toLowerCase()
  if (!want) return null
  let exact: StoredMax | null = null
  for (const m of maxes) {
    if (m.weight > 0 && m.lift_name.trim().toLowerCase() === want && (!exact || m.recorded_at > exact.recorded_at)) exact = m
  }
  if (exact) return exact
  const key = mainLiftKey(exerciseName)
  return key ? bestStoredMax(key, maxes) : null
}

const round = (kg: number, step = 2.5) => Math.round(kg / step) * step

export function loadHint(
  ex: { name: string; reps: string | null; intensity: string | null },
  maxes: StoredMax[],
): LoadHint | null {
  const target = parseTarget(ex.intensity)
  if (!target) return null
  const max = maxFor(ex.name, maxes)
  if (!max) return null
  if ('pct' in target) {
    return { kg: round((max.weight * target.pct) / 100), basis: `${target.pct}% of a ${max.weight} kg max (${max.lift_name})` }
  }
  const reps = parseReps(ex.reps)
  if (!reps) return null
  const kg = targetWeight(max.weight, reps, target.rpe)
  if (kg === null) return null
  return { kg, basis: `${reps} reps at RPE ${target.rpe} from a ${max.weight} kg max (${max.lift_name})` }
}
