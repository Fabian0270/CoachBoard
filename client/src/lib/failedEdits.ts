import type { ColKey } from './programUtils'

// ---------------------------------------------------------------------------
// Bookkeeping for program-grid edits the server would not accept.
//
// Pure and separate from the hook that does the saving, for the same reason the
// maths in shared/ is: this is the part that can be wrong without anything
// looking wrong. A cell in the grid holds its typed value in local draft state,
// so an edit that failed to save still SHOWS the new value — identical to one
// that succeeded. The registry below is the only thing that knows the
// difference, which makes its correctness the whole safety property.
// ---------------------------------------------------------------------------

export interface FailedEdit {
  date: string
  workoutId: string
  exerciseId: string
  patch: Record<string, unknown>
  /** The patch field that failed, NOT the column key — see fieldForColumn. */
  field: string
}

export type FailedEditMap = Record<string, FailedEdit>

/**
 * The patch field a grid column actually writes.
 *
 * Only one column disagrees with its own key: "Load Cap" is column `load_cap`
 * but is sent as `weight` (see ExerciseRow.commit, which routes every numeric
 * column to `weight`). Marking the failed cell means matching on what the patch
 * contained, so the exception has to live somewhere deliberate rather than being
 * rediscovered by whoever next touches the grid.
 */
export function fieldForColumn(column: ColKey | string): string {
  return column === 'load_cap' ? 'weight' : column
}

/** One entry per exercise+field; a later attempt replaces an earlier one. */
export function failedEditKey(exerciseId: string, field: string): string {
  return `${exerciseId}:${field}`
}

/** Key for a grid column, mapping the column name to the field that is sent. */
export function failedEditKeyForColumn(exerciseId: string, column: ColKey | string): string {
  return failedEditKey(exerciseId, fieldForColumn(column))
}

export function rememberFailure(map: FailedEditMap, edit: FailedEdit): FailedEditMap {
  return { ...map, [failedEditKey(edit.exerciseId, edit.field)]: edit }
}

export function clearFailure(
  map: FailedEditMap,
  exerciseId: string,
  field: string,
): FailedEditMap {
  const key = failedEditKey(exerciseId, field)
  if (!(key in map)) return map // same reference, so React skips the re-render
  const next = { ...map }
  delete next[key]
  return next
}

/**
 * Drop every outstanding edit for an exercise.
 *
 * Needed on delete: a deleted exercise cannot have pending edits, and leaving
 * them would keep the "could not be saved" banner up permanently with nothing
 * behind it that retrying could ever fix.
 */
export function clearFailuresForExercise(map: FailedEditMap, exerciseId: string): FailedEditMap {
  const entries = Object.entries(map).filter(([, e]) => e.exerciseId !== exerciseId)
  if (entries.length === Object.keys(map).length) return map
  return Object.fromEntries(entries)
}
