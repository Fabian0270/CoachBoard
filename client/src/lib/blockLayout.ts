import type { Exercise, Workout } from './programUtils'

// ---------------------------------------------------------------------------
// The block view: one weekday of the program, exercises down the side and
// weeks across, the way coaches lay out their own sheets.
//
// A row is "the same exercise on the same weekday", matched by name and
// position: the nth row named Squat on a Monday lines up with the nth row
// named Squat on every other Monday. That is the rule the "last week" line and
// the progression fill already use, so the three never disagree, and a set
// row follows its own set row. A week without that exercise leaves its cell
// empty, and typing there creates it (D41).
// ---------------------------------------------------------------------------

export interface BlockRow {
  /** "squat#0" — the name and which occurrence of it on the day. */
  key: string
  /** As the coach wrote it, from the first week that has it. */
  name: string
  /** A further set of the exercise above it, shown as ↳. */
  isSet: boolean
  /** The exercise in each week, or null where that week does not have it. */
  cells: (Exercise | null)[]
}

const nameKey = (ex: Exercise): string => ex.name.trim().toLowerCase()

/**
 * The rows for one weekday. `dates` is the program's calendar, seven days per
 * week, Monday first; `weekday` is 0 for Monday.
 *
 * Order follows the first week that has each exercise; a row that only a
 * later week has goes in right under the row before it in that week, so a
 * week that adds an exercise in the middle of the day shows it there.
 */
export function buildBlockRows(byDate: Map<string, Workout>, dates: string[], weekday: number): BlockRow[] {
  const weeks = Math.floor(dates.length / 7)
  const rows: BlockRow[] = []
  const byKey = new Map<string, BlockRow>()

  for (let w = 0; w < weeks; w++) {
    const exercises = byDate.get(dates[w * 7 + weekday])?.exercises ?? []
    const seen = new Map<string, number>()
    let previous: BlockRow | null = null
    exercises.forEach((ex, i) => {
      const name = nameKey(ex)
      // A row without a name lines up with nothing; it gets a row of its own.
      let key: string
      if (name) {
        const n = seen.get(name) ?? 0
        seen.set(name, n + 1)
        key = `${name}#${n}`
      } else {
        key = `blank:${ex.id}`
      }
      let row = byKey.get(key)
      if (!row) {
        const prev = exercises[i - 1]
        row = {
          key,
          name: ex.name.trim(),
          isSet: !!(ex.group_id && prev?.group_id === ex.group_id),
          cells: new Array<Exercise | null>(weeks).fill(null),
        }
        byKey.set(key, row)
        rows.splice(previous ? rows.indexOf(previous) + 1 : 0, 0, row)
      }
      row.cells[w] = ex
      previous = row
    })
  }
  return rows
}

/** How many weeks have training on each weekday, Monday first. */
export function weekdayCounts(byDate: Map<string, Workout>, dates: string[]): number[] {
  const counts = new Array<number>(7).fill(0)
  dates.forEach((date, i) => {
    if ((byDate.get(date)?.exercises.length ?? 0) > 0) counts[i % 7]++
  })
  return counts
}

/**
 * Where a row missing from week `week` belongs in that week's day: after the
 * nearest row above it that the week has, or first when there is none.
 */
export function anchorFor(rows: BlockRow[], row: BlockRow, week: number): Exercise | null {
  for (let i = rows.indexOf(row) - 1; i >= 0; i--) {
    const ex = rows[i].cells[week]
    if (ex) return ex
  }
  return null
}
