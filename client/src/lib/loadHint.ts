import { targetWeight } from 'coachboard-shared/rpe'
import { bestStoredMax, mainLiftKey } from 'coachboard-shared/vbt'
import { convertLoad, plateStep, unitOf, type LoadUnit } from 'coachboard-shared/units'

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
  /** The max's own unit; missing = kg. Converted to the program's when they differ (S3). */
  unit?: string
}

export interface LoadHint {
  /** The load, in the program's unit (the field predates lb; S3). */
  kg: number
  /** How it was worked out, for the tooltip: "RPE 8 × 5 reps of a 180 kg max". */
  basis: string
}

const num = (s: string) => Number(s.replace(',', '.'))

/** "-10%", "− 10 %", "+5%": a sign at the very start, so a range ("70-75%") never reads as one. */
export const SIGNED_PCT = /^([-−–+])\s*(\d+(?:[.,]\d+)?)\s*%/

/**
 * The target in an Intensity cell: an RPE, a percentage of 1RM, or a change
 * from the set above. Ranges give their middle.
 *
 * A percentage with a sign in front ("-10%", "+5%") is how coaches write a
 * back-off: 10% lighter than the set above, not 10% of the max. It is also the
 * form imported sheets' back-offs ("-0.10") are stored in.
 */
export function parseTarget(intensity: string | null | undefined): { rpe: number } | { pct: number } | { change: number } | null {
  const text = (intensity ?? '').trim()
  if (!text) return null
  const signed = text.match(SIGNED_PCT)
  if (signed) {
    const v = num(signed[2])
    return v > 0 && v < 100 ? { change: signed[1] === '+' ? v : -v } : null
  }
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

/** Rounded to the plates of the program's unit: 2.5 kg, 5 lb (S3). */
const round = (load: number, unit: LoadUnit) => Math.round(load / plateStep(unit)) * plateStep(unit)

/**
 * `above` is the load of the set directly above when it is the same movement
 * (its Load Cap, or its own suggestion): what a back-off is worked out from.
 */
export function loadHint(
  ex: { name: string; reps: string | null; intensity: string | null },
  maxes: StoredMax[],
  above: number | null = null,
  unit: LoadUnit = 'kg',
): LoadHint | null {
  const target = parseTarget(ex.intensity)
  if (!target) return null
  if ('change' in target) {
    if (above === null || above <= 0) return null
    const pct = Math.abs(target.change)
    return {
      kg: round((above * (100 + target.change)) / 100, unit),
      basis: `${pct}% ${target.change < 0 ? 'lighter' : 'heavier'} than the set above (${above} ${unit})`,
    }
  }
  return fromMax(ex, target, maxes, unit)
}

/**
 * The suggestion for every row of one day, top to bottom. A back-off ("-10%")
 * is worked out from the set directly above when it is the same movement: its
 * Load Cap, or its own suggestion when it has none, so a chain of back-offs
 * follows the top set. Rows are in the day's order; a set row (no name of its
 * own, or sharing its exercise's group) is the exercise above it.
 */
export function dayLoadHints(
  rows: { id: string; name: string; reps: string | null; intensity: string | null; weight: number | null; group_id: string | null }[],
  maxes: StoredMax[],
  unit: LoadUnit = 'kg',
): Map<string, LoadHint | null> {
  const out = new Map<string, LoadHint | null>()
  let prev: { id: string; weight: number | null; group_id: string | null; name: string } | null = null
  for (const ex of rows) {
    const p = prev
    const inGroup: boolean = !!p && !!ex.group_id && p.group_id === ex.group_id
    const name: string = inGroup && p ? p.name : ex.name
    const same: boolean = !!p && (inGroup || (!!name.trim() && p.name.trim().toLowerCase() === name.trim().toLowerCase()))
    const above: number | null = same && p ? p.weight ?? out.get(p.id)?.kg ?? null : null
    out.set(ex.id, loadHint({ ...ex, name }, maxes, above, unit))
    prev = { id: ex.id, weight: ex.weight, group_id: ex.group_id, name }
  }
  return out
}

function fromMax(
  ex: { name: string; reps: string | null },
  target: { rpe: number } | { pct: number },
  maxes: StoredMax[],
  unit: LoadUnit,
): LoadHint | null {
  const found = maxFor(ex.name, maxes)
  if (!found) return null
  // A max kept in the other unit after a switch without converting is read in this one.
  const weight = unitOf(found.unit) === unit ? found.weight : Math.round(convertLoad(found.weight, unitOf(found.unit), unit) * 10) / 10
  const max = { ...found, weight }
  if ('pct' in target) {
    return { kg: round((max.weight * target.pct) / 100, unit), basis: `${target.pct}% of a ${max.weight} ${unit} max (${max.lift_name})` }
  }
  const reps = parseReps(ex.reps)
  if (!reps) return null
  const kg = targetWeight(max.weight, reps, target.rpe, plateStep(unit))
  if (kg === null) return null
  return { kg, basis: `${reps} reps at RPE ${target.rpe} from a ${max.weight} ${unit} max (${max.lift_name})` }
}
