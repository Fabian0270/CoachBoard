import { describe, it, expect } from 'vitest'
import {
  clearFailure,
  clearFailuresForExercise,
  failedEditKey,
  failedEditKeyForColumn,
  fieldForColumn,
  rememberFailure,
  type FailedEdit,
  type FailedEditMap,
} from './failedEdits'

const edit = (exerciseId: string, field: string): FailedEdit => ({
  date: '2026-09-14',
  workoutId: 'w1',
  exerciseId,
  patch: { [field]: 'x' },
  field,
})

describe('fieldForColumn', () => {
  it('maps Load Cap to the field that is actually sent', () => {
    // ExerciseRow.commit routes every numeric column to `weight`, and load_cap
    // is the only numeric one. Marking the failed cell matches on the patch
    // field, so getting this wrong leaves the cell looking saved when it is not
    // — silently, which is the failure this whole mechanism exists to prevent.
    expect(fieldForColumn('load_cap')).toBe('weight')
  })

  it('leaves every other column as its own name', () => {
    for (const key of ['name', 'sets', 'reps', 'rest_time', 'intensity', 'load_used', 'rpe']) {
      expect(fieldForColumn(key)).toBe(key)
    }
  })

  it('builds a column key that matches the key the patch would produce', () => {
    expect(failedEditKeyForColumn('ex1', 'load_cap')).toBe(failedEditKey('ex1', 'weight'))
    expect(failedEditKeyForColumn('ex1', 'reps')).toBe(failedEditKey('ex1', 'reps'))
  })
})

describe('the failed-edit registry', () => {
  it('keeps one entry per exercise and field', () => {
    let map: FailedEditMap = {}
    map = rememberFailure(map, edit('ex1', 'reps'))
    map = rememberFailure(map, edit('ex1', 'sets'))
    expect(Object.keys(map)).toHaveLength(2)
  })

  it('replaces an earlier attempt at the same cell rather than stacking', () => {
    let map: FailedEditMap = {}
    map = rememberFailure(map, { ...edit('ex1', 'reps'), patch: { reps: '5' } })
    map = rememberFailure(map, { ...edit('ex1', 'reps'), patch: { reps: '8' } })
    expect(Object.keys(map)).toHaveLength(1)
    // The retry must send what the coach typed LAST, not their first attempt.
    expect(map[failedEditKey('ex1', 'reps')].patch).toEqual({ reps: '8' })
  })

  it('keeps the same cell on different exercises apart', () => {
    let map: FailedEditMap = {}
    map = rememberFailure(map, edit('ex1', 'reps'))
    map = rememberFailure(map, edit('ex2', 'reps'))
    expect(Object.keys(map)).toHaveLength(2)
  })

  it('forgets a cell once it saves', () => {
    let map = rememberFailure({}, edit('ex1', 'reps'))
    map = clearFailure(map, 'ex1', 'reps')
    expect(map).toEqual({})
  })

  it('returns the same object when there is nothing to clear', () => {
    const map = rememberFailure({}, edit('ex1', 'reps'))
    // Reference equality matters: a fresh object every time would re-render the
    // whole grid on every successful keystroke commit.
    expect(clearFailure(map, 'ex1', 'sets')).toBe(map)
    expect(clearFailuresForExercise(map, 'ex2')).toBe(map)
  })

  it('drops everything for a deleted exercise, and nothing else', () => {
    let map: FailedEditMap = {}
    map = rememberFailure(map, edit('ex1', 'reps'))
    map = rememberFailure(map, edit('ex1', 'sets'))
    map = rememberFailure(map, edit('ex2', 'reps'))

    const after = clearFailuresForExercise(map, 'ex1')
    // Otherwise the banner stays up forever pointing at a row that is gone, and
    // no amount of retrying can clear it.
    expect(Object.keys(after)).toEqual([failedEditKey('ex2', 'reps')])
  })
})
