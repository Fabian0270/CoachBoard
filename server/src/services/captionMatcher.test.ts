import { describe, it, expect } from 'vitest'
import { parseCaption, suggestWorkout, type CandidateWorkout } from './captionMatcher.js'

describe('parseCaption', () => {
  it('parses "180 kg for 2"', () => {
    const p = parseCaption('180 kg for 2')
    expect(p.weight).toBe(180)
    expect(p.reps).toBe(2)
    expect(p.rpe).toBeNull()
  })

  it('parses compact "180x2"', () => {
    const p = parseCaption('180x2')
    expect(p.weight).toBe(180)
    expect(p.reps).toBe(2)
  })

  it('parses "80kg x 5 @8" with RPE', () => {
    const p = parseCaption('80kg x 5 @8')
    expect(p.weight).toBe(80)
    expect(p.reps).toBe(5)
    expect(p.rpe).toBe(8)
  })

  it('parses "rpe 8.5" and decimal commas', () => {
    expect(parseCaption('182,5 x 1 rpe 8,5')).toMatchObject({ weight: 182.5, reps: 1, rpe: 8.5 })
  })

  it('does not read "@100kg" as an RPE', () => {
    // "@" followed by a number >10 is a load mention, not an RPE.
    expect(parseCaption('paused bench @ 100').rpe).toBeNull()
  })

  it('converts lbs to kg', () => {
    const p = parseCaption('405 lbs for 1')
    expect(p.weight).toBeCloseTo(183.7, 1)
  })

  it('parses Swedish "böj 180 för 2"', () => {
    const p = parseCaption('böj 180 för 2')
    expect(p.weight).toBe(180)
    expect(p.reps).toBe(2)
    expect(p.liftKeywords).toContain('squat')
  })

  it('detects lift keywords incl. short tokens with word boundaries', () => {
    expect(parseCaption('heavy squat single').liftKeywords).toContain('squat')
    expect(parseCaption('bench 100x3').liftKeywords).toContain('bench')
    expect(parseCaption('dl 220x1').liftKeywords).toContain('deadlift')
    expect(parseCaption('marklyft 200').liftKeywords).toContain('deadlift')
    // "handle" must not hit 'dl'; "markera" must not hit 'mark'.
    expect(parseCaption('new handle feels great').liftKeywords).not.toContain('deadlift')
    expect(parseCaption('kan du markera veckan?').liftKeywords).not.toContain('deadlift')
  })

  it('returns empty result for numberless or null captions', () => {
    expect(parseCaption('felt great today!')).toMatchObject({ weight: null, reps: null, rpe: null })
    expect(parseCaption(null)).toMatchObject({ weight: null, reps: null, rpe: null, liftKeywords: [] })
  })
})

const squatDay = (id: string, date: string): CandidateWorkout => ({
  workoutId: id,
  scheduledDate: date,
  exercises: [
    { name: 'Squat', weight: 180, load_used: null, reps: '2' },
    { name: 'Leg Press', weight: null, load_used: '200', reps: '8' },
  ],
})

const benchDay = (id: string, date: string): CandidateWorkout => ({
  workoutId: id,
  scheduledDate: date,
  exercises: [{ name: 'Bench Press', weight: 100, load_used: null, reps: '5' }],
})

describe('suggestWorkout', () => {
  it('a single candidate within ±1 day wins on date alone', () => {
    expect(suggestWorkout([squatDay('w1', '2026-07-02')], parseCaption(''), '2026-07-03')).toBe('w1')
  })

  it('two same-window workouts without caption info → no suggestion (ambiguous)', () => {
    const result = suggestWorkout(
      [squatDay('w1', '2026-07-03'), benchDay('w2', '2026-07-03')],
      parseCaption('felt good'),
      '2026-07-03',
    )
    expect(result).toBeNull()
  })

  it('caption lift keyword disambiguates two same-day workouts', () => {
    const result = suggestWorkout(
      [squatDay('w1', '2026-07-03'), benchDay('w2', '2026-07-03')],
      parseCaption('böj 180 kg for 2'),
      '2026-07-03',
    )
    expect(result).toBe('w1')
  })

  it('load + reps agreement picks the matching day', () => {
    const result = suggestWorkout(
      [squatDay('w1', '2026-07-03'), benchDay('w2', '2026-07-03')],
      parseCaption('bench 100x5'),
      '2026-07-03',
    )
    expect(result).toBe('w2')
  })

  it('no candidates within ±3 days → null', () => {
    expect(
      suggestWorkout([squatDay('w1', '2026-06-20')], parseCaption('180x2'), '2026-07-03'),
    ).toBeNull()
  })

  it('load within 7.5% tolerance counts as a match', () => {
    const result = suggestWorkout(
      [squatDay('w1', '2026-07-03'), benchDay('w2', '2026-07-03')],
      // 175 vs programmed 180 → within tolerance, squat keyword too
      parseCaption('squat 175 for 2'),
      '2026-07-03',
    )
    expect(result).toBe('w1')
  })
})

// S3 (D76): a caption is read in the athlete's unit.
describe('parseCaption in pounds', () => {
  it("a caption without a unit is in the athlete's", () => {
    expect(parseCaption('squat 225x3 @8', 'lb')).toMatchObject({ weight: 225, unit: 'lb', reps: 3, rpe: 8 })
  })
  it('one naming the other unit is converted', () => {
    expect(parseCaption('100 kg x 3', 'lb').weight).toBeCloseTo(220.5, 1)
    expect(parseCaption('225 lbs x 3', 'kg').weight).toBeCloseTo(102.1, 1)
    expect(parseCaption('225 lb x 3', 'lb').weight).toBe(225)
  })
  it('kg is the default', () => {
    expect(parseCaption('180x2')).toMatchObject({ weight: 180, unit: 'kg' })
  })
})