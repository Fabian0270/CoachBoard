import type { Exercise, Workout } from './programUtils'

// ---------------------------------------------------------------------------
// Progression fill: take one exercise as it is in a starting week and step it
// week by week through the rest of the block.
//
// "Copy to weeks" makes identical copies, after which the coach edited every
// week by hand to add 2.5 kg or half an RPE. This works the steps out. It only
// changes rows that already exist — the same exercise on the same weekday in
// a later week, matched by name and position the way the "last week" line
// matches them — so a set row follows its own set row. It never creates days.
// ---------------------------------------------------------------------------

export interface ProgressionRule {
  /** kg added to Load Cap per week. */
  loadStep: number
  /** Added to an RPE target per week ("RPE 8", "@8", "8"). */
  rpeStep: number
  /** Percentage points added to a % target per week ("75%"). */
  pctStep: number
  /** Reps added per week (negative to take reps off). Plain numbers only. */
  repsStep: number
  /** Week indexes (0-based) that are deloads: lighter, and not counted as a step. */
  deloadWeeks: number[]
}

/** How a deload week is made lighter than the week before it. */
export const DELOAD = { loadFactor: 0.9, rpeOff: 1, pctOff: 10 }

export interface PlannedChange {
  exerciseId: string
  date: string
  weekIndex: number
  /** What will be sent: only the fields that change. */
  patch: Partial<Pick<Exercise, 'weight' | 'intensity' | 'reps'>>
  /** For the preview. */
  before: { weight: number | null; intensity: string | null; reps: string | null }
  after: { weight: number | null; intensity: string | null; reps: string | null }
  deload: boolean
}

const round = (n: number, step: number) => Math.round(n / step) * step
const fmt = (n: number) => String(Math.round(n * 100) / 100).replace(/\.0+$/, '')

/** The same intensity text with its RPE or % number moved; null when there is none to move. */
export function stepIntensity(intensity: string | null, rpeDelta: number, pctDelta: number): string | null {
  if (!intensity) return null
  const pct = intensity.match(/(\d+(?:[.,]\d+)?)(\s*%)/)
  if (pct) {
    if (pctDelta === 0) return null
    const v = Math.min(110, Math.max(0, Number(pct[1].replace(',', '.')) + pctDelta))
    return intensity.replace(pct[0], `${fmt(v)}${pct[2]}`)
  }
  if (rpeDelta === 0) return null
  const rpe = intensity.match(/((?:rpe\s*|@\s*))(\d+(?:[.,]\d+)?)/i) ?? intensity.match(/^()(\d+(?:[.,]\d+)?)$/)
  if (!rpe) return null
  const v = Math.min(10, Math.max(5, round(Number(rpe[2].replace(',', '.')) + rpeDelta, 0.5)))
  return intensity.replace(rpe[0], `${rpe[1]}${fmt(v)}`)
}

/**
 * Every change a fill would make. `dates` is the program's calendar, week by
 * week (7 days each), as the page lays it out.
 */
export function planProgression(
  workouts: Workout[],
  dates: string[],
  exerciseName: string,
  startWeek: number,
  rule: ProgressionRule,
): PlannedChange[] {
  const want = exerciseName.trim().toLowerCase()
  const byDate = new Map(workouts.filter((w) => w.scheduled_date).map((w) => [w.scheduled_date!, w]))
  const rowsOf = (date: string | undefined) =>
    (date ? byDate.get(date)?.exercises ?? [] : []).filter((e) => e.name.trim().toLowerCase() === want)
  const weeks = Math.floor(dates.length / 7)
  const deload = new Set(rule.deloadWeeks)
  const changes: PlannedChange[] = []

  for (let weekday = 0; weekday < 7; weekday++) {
    const base = rowsOf(dates[startWeek * 7 + weekday])
    if (base.length === 0) continue
    let steps = 0
    for (let week = startWeek + 1; week < weeks; week++) {
      const isDeload = deload.has(week)
      if (!isDeload) steps++
      const date = dates[week * 7 + weekday]
      const rows = rowsOf(date)
      rows.forEach((row, n) => {
        const from = base[n]
        if (!from) return
        let weight = from.weight != null && rule.loadStep !== 0 ? round(from.weight + steps * rule.loadStep, 0.5) : null
        let intensity = stepIntensity(from.intensity, steps * rule.rpeStep, steps * rule.pctStep)
        let reps: string | null = null
        if (rule.repsStep !== 0 && from.reps && /^\d+$/.test(from.reps.trim())) {
          reps = String(Math.max(1, Number(from.reps) + steps * rule.repsStep))
        }
        if (isDeload) {
          // A deload is the week before it made lighter: the steps so far, then off.
          const prevWeight = from.weight != null ? from.weight + steps * rule.loadStep : null
          weight = prevWeight != null ? round(prevWeight * DELOAD.loadFactor, 2.5) : null
          intensity = stepIntensity(from.intensity, steps * rule.rpeStep - DELOAD.rpeOff, steps * rule.pctStep - DELOAD.pctOff)
        }
        const patch: PlannedChange['patch'] = {}
        if (weight != null && weight !== row.weight) patch.weight = weight
        if (intensity != null && intensity !== row.intensity) patch.intensity = intensity
        if (reps != null && reps !== row.reps) patch.reps = reps
        if (Object.keys(patch).length === 0) return
        changes.push({
          exerciseId: row.id,
          date: date!,
          weekIndex: week,
          patch,
          before: { weight: row.weight, intensity: row.intensity, reps: row.reps },
          after: {
            weight: patch.weight ?? row.weight,
            intensity: patch.intensity ?? row.intensity,
            reps: patch.reps ?? row.reps,
          },
          deload: isDeload,
        })
      })
    }
  }
  return changes
}
