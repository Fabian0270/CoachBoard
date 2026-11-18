import { competitionLiftKey } from 'coachboard-shared/vbt'
import { dayLoadHints, type StoredMax } from './loadHint'
import type { LoadUnit } from 'coachboard-shared/units'
import type { Workout } from './programUtils'

// ---------------------------------------------------------------------------
// Volume in the program report (I3): weekly sets and tonnage per lift, what
// was planned against what the athlete did.
//
// Grouped as Squat, Bench, Deadlift and Other (D43). Only the competition
// lifts count as the big three: a pause squat or a Romanian deadlift is a
// variation, and goes under Other.
//
// Planned load is the row's Load Cap. A row with none uses the suggested load
// the day editor shows (from the max, or the set above for a back-off) and is
// marked as estimated; a row with no suggestion counts its sets only (D44).
//
// What was done: the athlete logs a load and an RPE per row, not sets and
// reps, so a row with a result counts its prescribed sets and reps at the
// load they logged.
// ---------------------------------------------------------------------------

export type VolumeLift = 'squat' | 'bench' | 'deadlift' | 'other'
export const VOLUME_LIFTS: VolumeLift[] = ['squat', 'bench', 'deadlift', 'other']
export const VOLUME_LABELS: Record<VolumeLift, string> = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', other: 'Other' }

/** Squat, Bench, Deadlift by exact competition-lift name (D43, D47); everything else is Other. */
export function volumeLift(name: string): VolumeLift {
  return competitionLiftKey(name) ?? 'other'
}

export interface VolumeCell {
  plannedSets: number
  doneSets: number
  /** Load lifted, planned: sets × reps × load, in the program's unit (the name predates lb). */
  plannedKg: number
  doneKg: number
  /** Some of the planned tonnage comes from a suggested load. */
  estimated: boolean
}

export interface VolumeWeek {
  weekIndex: number
  byLift: Record<VolumeLift, VolumeCell>
}

/** A count from a cell: "3" → 3, "3-5" → 4 (its middle), "3x" → 3. Null when there is none. */
export function countOf(text: string | null | undefined): number | null {
  const m = (text ?? '').match(/(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?/)
  if (!m) return null
  const a = Number(m[1].replace(',', '.'))
  const n = m[2] ? (a + Number(m[2].replace(',', '.'))) / 2 : a
  return n > 0 ? n : null
}

const kgOf = (text: string | null | undefined): number | null => {
  const n = Number((text ?? '').replace(',', '.').replace(/\s*(?:kgs?|lbs?)$/i, '').trim())
  return (text ?? '').trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
}

const empty = (): VolumeCell => ({ plannedSets: 0, doneSets: 0, plannedKg: 0, doneKg: 0, estimated: false })

/** Weekly volume for a program, week 0 starting on the Monday of its start date. */
export function computeVolume(workouts: Workout[], startDate: string | null, maxes: StoredMax[], unit: LoadUnit = 'kg'): VolumeWeek[] {
  if (!startDate) return []
  const monday = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    return d.getTime()
  }
  const start = monday(startDate)
  const weeks = new Map<number, VolumeWeek>()

  for (const w of workouts) {
    if (!w.scheduled_date) continue
    const weekIndex = Math.floor((monday(w.scheduled_date) - start) / (7 * 86_400_000))
    if (weekIndex < 0) continue
    const week = weeks.get(weekIndex) ?? {
      weekIndex,
      byLift: { squat: empty(), bench: empty(), deadlift: empty(), other: empty() },
    }
    weeks.set(weekIndex, week)

    const rows = [...w.exercises].sort((a, b) => a.order_index - b.order_index)
    const hints = dayLoadHints(rows, maxes, unit)
    let prevName = ''
    let prevGroup: string | null = null
    for (const ex of rows) {
      // A set row is the exercise it belongs to.
      const name = ex.group_id && ex.group_id === prevGroup && !ex.name.trim() ? prevName : ex.name
      prevName = name
      prevGroup = ex.group_id
      const sets = countOf(ex.sets)
      if (!sets) continue
      const cell = week.byLift[volumeLift(name)]
      const reps = countOf(ex.reps)

      cell.plannedSets += sets
      const hint = hints.get(ex.id)
      const planned = ex.weight ?? hint?.kg ?? null
      if (reps && planned) {
        cell.plannedKg += sets * reps * planned
        if (ex.weight == null) cell.estimated = true
      }

      const done = (ex.load_used ?? '').trim() !== '' || (ex.rpe ?? '').trim() !== ''
      if (done) {
        cell.doneSets += sets
        const used = kgOf(ex.load_used)
        if (reps && used) cell.doneKg += sets * reps * used
      }
    }
  }
  return [...weeks.values()].sort((a, b) => a.weekIndex - b.weekIndex)
}
