import { describe, it, expect } from 'vitest'
import { planProgression, stepIntensity, type ProgressionRule } from './progression'
import type { Workout, Exercise } from './programUtils'

const ex = (id: string, workout_id: string, extra: Partial<Exercise>): Exercise => ({
  id, workout_id, name: 'Squat', sets: '5', reps: '5', weight: 140, duration: null, distance: null, notes: null,
  order_index: 0, rest_time: null, intensity: 'RPE 7', load_used: null, rpe: null, group_id: null,
  suggestion_note: null, ...extra,
})
const day = (id: string, date: string, exercises: Exercise[]): Workout => ({
  id, program_id: 'p1', name: date, scheduled_date: date, completed_at: null, notes: null, created_at: '', exercises,
})
/** Four weeks from Monday 2026-06-15. */
const dates = Array.from({ length: 28 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 5, 15 + i))
  return d.toISOString().slice(0, 10)
})
const mon = (w: number) => dates[w * 7]
const thu = (w: number) => dates[w * 7 + 3]
const rule = (r: Partial<ProgressionRule>): ProgressionRule => ({ loadStep: 0, rpeStep: 0, pctStep: 0, repsStep: 0, deloadWeeks: [], ...r })

// Week 1 copied to every week: identical Monday squat each week.
const copied = [0, 1, 2, 3].map((w) => day(`w${w}`, mon(w), [ex(`s${w}`, `w${w}`, {}), ex(`r${w}`, `w${w}`, { name: 'Rows', weight: 60 })]))

describe('stepIntensity', () => {
  it('moves an RPE, keeping how it was written', () => {
    expect(stepIntensity('RPE 7', 0.5, 0)).toBe('RPE 7.5')
    expect(stepIntensity('@7', 1, 0)).toBe('@8')
    expect(stepIntensity('7', 1.5, 0)).toBe('8.5')
    expect(stepIntensity('RPE 9.5', 1, 0)).toBe('RPE 10')
  })
  it('moves a percentage', () => {
    expect(stepIntensity('75%', 0, 2.5)).toBe('77.5%')
    expect(stepIntensity('70 % x3', 0, 5)).toBe('75 % x3')
  })
  it('leaves what has no target alone', () => {
    expect(stepIntensity('tempo', 1, 1)).toBeNull()
    expect(stepIntensity('75%', 1, 0)).toBeNull()
  })
})

describe('planProgression', () => {
  it('adds the steps week by week from the starting week, and only to that exercise', () => {
    const plan = planProgression(copied, dates, 'squat', 0, rule({ loadStep: 2.5, rpeStep: 0.5 }))
    expect(plan.map((c) => [c.weekIndex, c.after.weight, c.after.intensity])).toEqual([
      [1, 142.5, 'RPE 7.5'],
      [2, 145, 'RPE 8'],
      [3, 147.5, 'RPE 8.5'],
    ])
    expect(plan.every((c) => c.exerciseId.startsWith('s'))).toBe(true)
  })

  it('makes a deload week lighter than the week before, and does not count it as a step', () => {
    const plan = planProgression(copied, dates, 'Squat', 0, rule({ loadStep: 5, rpeStep: 0.5, deloadWeeks: [2] }))
    expect(plan.map((c) => [c.weekIndex, c.after.weight, c.after.intensity, c.deload])).toEqual([
      [1, 145, 'RPE 7.5', false],
      // 145 × 0.9 = 130.5 → 130; RPE 7.5 − 1.
      [2, 130, 'RPE 6.5', true],
      [3, 150, 'RPE 8', false],
    ])
  })

  it('steps each weekday from its own starting value, and set rows from their own', () => {
    const w = [0, 1].map((k) => [
      day(`m${k}`, mon(k), [ex(`m${k}a`, `m${k}`, { weight: 100 }), ex(`m${k}b`, `m${k}`, { weight: 90, group_id: 'g' })]),
      day(`t${k}`, thu(k), [ex(`t${k}a`, `t${k}`, { weight: 120 })]),
    ]).flat()
    const plan = planProgression(w, dates.slice(0, 14), 'Squat', 0, rule({ loadStep: 2.5 }))
    expect(plan.map((c) => `${c.exerciseId}:${c.after.weight}`).sort()).toEqual(['m1a:102.5', 'm1b:92.5', 't1a:122.5'])
  })

  it('changes reps when asked, from a plain number only', () => {
    const w = [0, 1, 2].map((k) => day(`w${k}`, mon(k), [ex(`s${k}`, `w${k}`, { reps: '5' })]))
    const plan = planProgression(w, dates.slice(0, 21), 'Squat', 0, rule({ repsStep: -1 }))
    expect(plan.map((c) => [c.weekIndex, c.after.reps])).toEqual([[1, '4'], [2, '3']])
    // A range in the starting week has no single number to step from.
    const ranged = [0, 1].map((k) => day(`v${k}`, mon(k), [ex(`v${k}`, `v${k}`, { reps: '8-10' })]))
    expect(planProgression(ranged, dates.slice(0, 14), 'Squat', 0, rule({ repsStep: -1 }))).toEqual([])
  })

  it('starts from a later week, leaving the weeks before it alone', () => {
    const plan = planProgression(copied, dates, 'Squat', 2, rule({ loadStep: 2.5 }))
    expect(plan.map((c) => c.weekIndex)).toEqual([3])
  })

  it('skips weeks where the exercise is not, and sends only what changes', () => {
    const w = [copied[0], day('w1', mon(1), [ex('r1', 'w1', { name: 'Rows' })]), copied[2]]
    const plan = planProgression(w, dates, 'Squat', 0, rule({ loadStep: 2.5 }))
    expect(plan.map((c) => [c.weekIndex, c.patch])).toEqual([[2, { weight: 145 }]])
  })
})
