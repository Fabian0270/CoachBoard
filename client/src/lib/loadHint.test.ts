import { describe, it, expect } from 'vitest'
import { targetWeight } from 'coachboard-shared/rpe'
import { loadHint, parseTarget, parseReps, maxFor } from './loadHint'

const maxes = [
  { lift_name: 'Squat', weight: 180, recorded_at: '2026-05-01' },
  { lift_name: 'Squat', weight: 185, recorded_at: '2026-06-01' },
  { lift_name: 'Bench Press', weight: 120, recorded_at: '2026-06-01' },
  { lift_name: 'Pause Squat', weight: 160, recorded_at: '2026-06-01' },
]

describe('parseTarget', () => {
  it('reads RPE written the ways coaches write it', () => {
    for (const t of ['RPE 8', 'rpe8', '@8', '@ 8', '8']) expect(parseTarget(t)).toEqual({ rpe: 8 })
    expect(parseTarget('7-8')).toEqual({ rpe: 7.5 })
    expect(parseTarget('RPE 8,5')).toEqual({ rpe: 8.5 })
  })
  it('reads a percentage, a range giving its middle', () => {
    expect(parseTarget('75%')).toEqual({ pct: 75 })
    expect(parseTarget('70-80 %')).toEqual({ pct: 75 })
  })
  it('ignores what is not a target', () => {
    for (const t of ['', null, 'heavy', '140', 'RPE 12', 'tempo 3-1-1']) expect(parseTarget(t)).toBeNull()
  })
})

describe('parseReps', () => {
  it('takes the top of a range, the lighter load', () => {
    expect(parseReps('5')).toBe(5)
    expect(parseReps('8-10')).toBe(10)
    expect(parseReps('AMRAP')).toBeNull()
  })
})

describe('maxFor', () => {
  it("uses the competition lift's most recent max for the competition lift", () => {
    expect(maxFor('Back Squat', maxes)?.weight).toBe(185)
    expect(maxFor('Bench press', maxes)?.weight).toBe(120)
  })
  it('uses a variation only when a max is stored under exactly its name', () => {
    expect(maxFor('Pause Squat', maxes)?.weight).toBe(160)
    expect(maxFor('Front Squat', maxes)).toBeNull()
  })
})

describe('loadHint', () => {
  it('works out RPE × reps from the max, with the chart the cheat sheet uses', () => {
    const hint = loadHint({ name: 'Squat', reps: '5', intensity: 'RPE 8' }, maxes)
    expect(hint?.kg).toBe(targetWeight(185, 5, 8))
    expect(hint?.basis).toBe('5 reps at RPE 8 from a 185 kg max (Squat)')
  })
  it('works out a percentage, rounded to 2.5 kg', () => {
    expect(loadHint({ name: 'Bench Press', reps: '3', intensity: '77%' }, maxes)?.kg).toBe(92.5)
  })
  it('reads "-10%" as 10% lighter than the set above, not 10% of the max', () => {
    for (const t of ['-10%', '- 10 %', '−10%', '–10%']) expect(parseTarget(t)).toEqual({ change: -10 })
    expect(parseTarget('+5%')).toEqual({ change: 5 })
    // A range is still a range.
    expect(parseTarget('70-75%')).toEqual({ pct: 72.5 })
    const backoff = loadHint({ name: 'Squat', reps: '5', intensity: '-10%' }, maxes, 150)
    expect(backoff).toEqual({ kg: 135, basis: '10% lighter than the set above (150 kg)' })
    // Rounded to 2.5 kg like every suggestion: 90% of 142.5 is 128.25.
    expect(loadHint({ name: 'Squat', reps: '5', intensity: '-10%' }, maxes, 142.5)?.kg).toBe(127.5)
    expect(loadHint({ name: 'Squat', reps: '5', intensity: '+5%' }, maxes, 100)?.kg).toBe(105)
  })
  it('suggests no back-off without a set above to take it from, max or not', () => {
    expect(loadHint({ name: 'Squat', reps: '5', intensity: '-10%' }, maxes)).toBeNull()
    expect(loadHint({ name: 'Squat', reps: '5', intensity: '-10%' }, [], null)).toBeNull()
    // …and needs no max when there is one.
    expect(loadHint({ name: 'Leg Press', reps: '10', intensity: '-10%' }, [], 200)?.kg).toBe(180)
  })
  it('gives nothing without a target, a max, or reps for an RPE', () => {
    expect(loadHint({ name: 'Squat', reps: '5', intensity: null }, maxes)).toBeNull()
    expect(loadHint({ name: 'Leg Press', reps: '10', intensity: 'RPE 8' }, maxes)).toBeNull()
    expect(loadHint({ name: 'Squat', reps: null, intensity: 'RPE 8' }, maxes)).toBeNull()
  })
})
