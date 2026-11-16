import { describe, it, expect } from 'vitest'
import type { Exercise, Workout } from './programUtils'
import { buildBlockRows, weekdayCounts, anchorFor } from './blockLayout'

let n = 0
const ex = (name: string, extra: Partial<Exercise> = {}): Exercise => ({
  id: `e${++n}`, workout_id: 'w', name, sets: null, reps: null, weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
} as Exercise)

// Three weeks, Monday first. Mondays are index 0, 7, 14.
const DATES = Array.from({ length: 21 }, (_, i) => `2026-06-${String(8 + i).padStart(2, '0')}`)
const mondays = (...days: Exercise[][]) => {
  const map = new Map<string, Workout>()
  days.forEach((exercises, w) => map.set(DATES[w * 7], { id: `w${w}`, exercises } as Workout))
  return map
}
const shape = (rows: ReturnType<typeof buildBlockRows>) =>
  rows.map((r) => `${r.isSet ? '↳' : ''}${r.name}: ${r.cells.map((c) => (c ? c.sets ?? 'x' : '-')).join(' ')}`)

describe('buildBlockRows', () => {
  it('lines the same exercise up across the weeks', () => {
    const rows = buildBlockRows(mondays(
      [ex('Squat', { sets: '3' }), ex('Bench', { sets: '4' })],
      [ex('Squat', { sets: '4' }), ex('Bench', { sets: '4' })],
      [ex('squat ', { sets: '5' }), ex('Bench', { sets: '5' })],
    ), DATES, 0)
    expect(shape(rows)).toEqual(['Squat: 3 4 5', 'Bench: 4 4 5'])
  })

  it('a set row follows its own set row, by position', () => {
    const g = 'g1', h = 'g2'
    const rows = buildBlockRows(mondays(
      [ex('Squat', { sets: '1', group_id: g }), ex('Squat', { sets: '3', group_id: g })],
      [ex('Squat', { sets: '1', group_id: h }), ex('Squat', { sets: '4', group_id: h })],
    ), DATES, 0)
    expect(shape(rows)).toEqual(['Squat: 1 1 -', '↳Squat: 3 4 -'])
  })

  it('a week missing an exercise leaves its cell empty', () => {
    const rows = buildBlockRows(mondays(
      [ex('Squat'), ex('Bench')],
      [ex('Squat')],
      [],
    ), DATES, 0)
    expect(shape(rows)).toEqual(['Squat: x x -', 'Bench: x - -'])
  })

  it('an exercise only a later week has goes in where that week has it', () => {
    const rows = buildBlockRows(mondays(
      [ex('Squat'), ex('Bench')],
      [ex('Squat'), ex('Pause Squat'), ex('Bench')],
      [ex('Deadlift'), ex('Squat')],
    ), DATES, 0)
    expect(rows.map((r) => r.name)).toEqual(['Deadlift', 'Squat', 'Pause Squat', 'Bench'])
  })

  it('a row without a name stands alone', () => {
    const rows = buildBlockRows(mondays([ex(''), ex('Squat')], [ex(''), ex('Squat')]), DATES, 0)
    expect(rows.map((r) => r.key.startsWith('blank:') ? 'blank' : r.key)).toEqual(['blank', 'blank', 'squat#0'])
  })

  it('reads only the chosen weekday', () => {
    const map = mondays([ex('Squat')])
    map.set(DATES[3], { id: 'thu', exercises: [ex('Bench')] } as Workout)
    expect(buildBlockRows(map, DATES, 3).map((r) => r.name)).toEqual(['Bench'])
    expect(weekdayCounts(map, DATES)).toEqual([1, 0, 0, 1, 0, 0, 0])
  })
})

describe('anchorFor', () => {
  it('is the nearest row above that the week has, or null for the top', () => {
    const rows = buildBlockRows(mondays(
      [ex('Squat'), ex('Pause Squat'), ex('Bench')],
      [ex('Squat'), ex('Bench')],
    ), DATES, 0)
    const [squat, pause, bench] = rows
    expect(anchorFor(rows, pause, 1)?.id).toBe(squat.cells[1]!.id)
    expect(anchorFor(rows, bench, 1)?.id).toBe(squat.cells[1]!.id)
    expect(anchorFor(rows, squat, 1)).toBeNull()
  })
})
