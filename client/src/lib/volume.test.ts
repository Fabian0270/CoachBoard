import { describe, it, expect } from 'vitest'
import type { Exercise, Workout } from './programUtils'
import { computeVolume, countOf, volumeLift } from './volume'

let n = 0
const ex = (name: string, extra: Partial<Exercise> = {}): Exercise => ({
  id: `e${++n}`, workout_id: 'w', name, sets: '3', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: n, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
} as Exercise)
const day = (date: string, exercises: Exercise[]) => ({ id: date, scheduled_date: date, exercises } as Workout)
const maxes = [{ lift_name: 'Squat', weight: 200, recorded_at: '2026-01-01' }]

describe('volumeLift', () => {
  it('counts only the competition lifts as the big three', () => {
    for (const name of ['Squat', 'competition squat', ' Knäböj ']) expect(volumeLift(name), name).toBe('squat')
    for (const name of ['Bench', 'Bench Press', 'Competition Bench', 'Bänkpress']) expect(volumeLift(name), name).toBe('bench')
    for (const name of ['Deadlift', 'Sumo Deadlift', 'Marklyft']) expect(volumeLift(name), name).toBe('deadlift')
  })
  it('puts every variation under Other', () => {
    for (const name of ['Pause Squat', 'Front Squat', 'Tempo Squat', 'Close Grip Bench', 'Larsen Press', 'Romanian Deadlift', 'Deficit Deadlift', 'Rows']) {
      expect(volumeLift(name), name).toBe('other')
    }
  })
})

describe('countOf', () => {
  it('reads a count, a range giving its middle', () => {
    expect(countOf('3')).toBe(3)
    expect(countOf('3-5')).toBe(4)
    expect(countOf('3x')).toBe(3)
    expect(countOf('AMRAP')).toBeNull()
    expect(countOf(null)).toBeNull()
  })
})

describe('computeVolume', () => {
  it('adds sets and tonnage per lift per week, planned against done', () => {
    const weeks = computeVolume([
      day('2026-06-15', [
        ex('Squat', { sets: '3', reps: '5', weight: 150, load_used: '150', rpe: '8' }),
        ex('Pause Squat', { sets: '2', reps: '3', weight: 100 }),
        ex('Bench', { sets: '4', reps: '8', weight: 80 }),
      ]),
      day('2026-06-24', [ex('Squat', { sets: '3', reps: '5', weight: 155 })]),
    ], '2026-06-15', [])
    expect(weeks.map((w) => w.weekIndex)).toEqual([0, 1])
    const [w1, w2] = weeks
    expect(w1.byLift.squat).toEqual({ plannedSets: 3, doneSets: 3, plannedKg: 2250, doneKg: 2250, estimated: false })
    // The pause squat is a variation.
    expect(w1.byLift.other).toMatchObject({ plannedSets: 2, plannedKg: 600, doneSets: 0, doneKg: 0 })
    expect(w1.byLift.bench).toMatchObject({ plannedSets: 4, plannedKg: 2560, doneSets: 0 })
    expect(w2.byLift.squat.plannedKg).toBe(2325)
  })

  it('a row with no Load Cap uses the suggested load, marked estimated, a back-off from the set above', () => {
    const [w] = computeVolume([day('2026-06-15', [
      ex('Squat', { sets: '1', reps: '3', weight: 180, group_id: 'g' }),
      ex('Squat', { sets: '3', reps: '5', intensity: '-10%', group_id: 'g' }),
    ])], '2026-06-15', maxes)
    // 1×3×180 + 3×5×162.5 (90% of 180, rounded to 2.5)
    expect(w.byLift.squat).toMatchObject({ plannedSets: 4, plannedKg: 540 + 15 * 162.5, estimated: true })
  })

  it('a row with no load and no suggestion counts its sets only', () => {
    const [w] = computeVolume([day('2026-06-15', [ex('Pull-ups', { sets: '3', reps: '8' })])], '2026-06-15', maxes)
    expect(w.byLift.other).toMatchObject({ plannedSets: 3, plannedKg: 0, estimated: false })
  })

  it('done counts the prescribed sets and reps at the load the athlete logged', () => {
    const [w] = computeVolume([day('2026-06-15', [
      ex('Deadlift', { sets: '2', reps: '3', weight: 200, load_used: '205', rpe: '8' }),
      // An RPE with no load: the sets are done, no tonnage to add.
      ex('Deadlift', { sets: '1', reps: '3', weight: 210, rpe: '9' }),
    ])], '2026-06-15', [])
    expect(w.byLift.deadlift).toMatchObject({ plannedSets: 3, doneSets: 3, plannedKg: 1200 + 630, doneKg: 1230 })
  })
})
