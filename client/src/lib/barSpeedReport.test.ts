import { describe, expect, it } from 'vitest'
import { barSpeedSets, competitionLiftOf, weekIndexOf } from './barSpeedReport'
import type { VideoAnalysisDto, AnalysisLink } from 'coachboard-shared/videoAnalysis'

// L2 in the report (D68, D69).

const rep = (index: number, mean: number) => ({
  index, startT: index * 3, endT: index * 3 + 1, durationMs: 1000, romPx: 100, meanVelocityPxS: mean * 200, peakVelocityPxS: mean * 260,
  romM: 0.5, meanVelocity: mean, peakVelocity: mean * 1.3, meanPropulsiveVelocity: null, propulsiveFraction: null,
})

const program = {
  id: 'p1',
  start_date: '2026-11-18', // a Wednesday: week 0 starts Monday 16 Nov
  workouts: [{ id: 'w1', scheduled_date: '2026-11-17' }, { id: 'w2', scheduled_date: '2026-11-24' }],
}

const link = (over: Partial<AnalysisLink> = {}): AnalysisLink => ({
  workoutId: 'w1', date: '2026-11-17', workoutName: 'Heavy day', programId: 'p1', programName: 'Block',
  exerciseId: 'e1', exerciseName: 'Squat', ...over,
})

let n = 0
const set = (over: Partial<VideoAnalysisDto>): VideoAnalysisDto => ({
  id: `a${++n}`, mediaId: null, athleteId: 'ath', athleteName: 'Ada', sourceLabel: '', track: [], calibration: null,
  metrics: [rep(0, 0.6)], notes: null, hasVideo: false, createdAt: '2026-11-17T18:00:00', updatedAt: '2026-11-17T18:00:00',
  liftedAt: '2026-11-17T18:00:00', lift: 'back-squat', loadKg: 180, calledRpe: null, metric: null, link: link(), ...over,
})

const trends = [{
  liftKey: 'squat', displayName: 'Squat', latestE1RM: 205, bestE1RM: 205,
  dataPoints: [{ weekIndex: 0, e1rm: 205, weight: 180, reps: 3, rpe: 8, exerciseName: 'Squat' }],
}]

describe('competitionLiftOf', () => {
  it('the three competition lifts; variations are not', () => {
    expect(competitionLiftOf('back-squat')).toBe('squat')
    expect(competitionLiftOf('bench-press')).toBe('bench')
    expect(competitionLiftOf('deadlift-sumo')).toBe('deadlift')
    expect(competitionLiftOf('front-squat')).toBeNull()
    expect(competitionLiftOf('deadlift-trapbar')).toBeNull()
    expect(competitionLiftOf(null)).toBeNull()
  })
})

describe('weekIndexOf', () => {
  it('weeks from the Monday of the start, as the report counts them', () => {
    expect(weekIndexOf('2026-11-16', '2026-11-18')).toBe(0)
    expect(weekIndexOf('2026-11-22', '2026-11-18')).toBe(0)
    expect(weekIndexOf('2026-11-23', '2026-11-18')).toBe(1)
    expect(weekIndexOf(null, '2026-11-18')).toBeNull()
  })
})

describe('barSpeedSets', () => {
  it("this program's linked competition lifts only, with the week's e1RM beside them", () => {
    const rows = barSpeedSets(program, [
      set({ loadKg: 180 }),
      set({ link: link({ programId: 'other' }) }),
      set({ link: null }),
      set({ lift: 'front-squat' }),
      set({ lift: 'bench-press', loadKg: 100, link: link({ workoutId: 'w2', date: '2026-11-24', exerciseName: 'Bench' }), liftedAt: '2026-11-24T18:00:00' }),
    ], {}, trends)
    expect(rows.map((r) => [r.weekIndex, r.liftKey, r.loadKg, r.speed, r.rpeE1rm])).toEqual([
      [0, 'squat', 180, 0.6, 205],
      // Bench reads peak speed by default.
      [1, 'bench', 100, 0.78, null],
    ])
  })

  it("the day's max from that day's sets, none from a thin day", () => {
    const day = [
      set({ loadKg: 140, metrics: [rep(0, 0.8)] }),
      set({ loadKg: 160, metrics: [rep(0, 0.65)] }),
      set({ loadKg: 180, metrics: [rep(0, 0.5)] }),
    ]
    const rows = barSpeedSets(program, day, { 'back-squat': 0.3 }, trends)
    expect(rows).toHaveLength(3)
    // 0.15 m/s per 20 kg, 0.3 m/s at the max: 180 + 0.2 / 0.0075 ≈ 206.7.
    expect(rows[0].dayMax).toBeCloseTo(206.7, 0)
    expect(barSpeedSets(program, day.slice(0, 2), { 'back-squat': 0.3 }, trends)[0].dayMax).toBeNull()
  })

  it('a mistracked rep does not count as the fastest', () => {
    const rows = barSpeedSets(program, [set({ metrics: [rep(0, 0.6), { ...rep(1, 0.9), peakVelocity: 4 }] })], {}, trends)
    expect(rows[0].speed).toBe(0.6)
  })
})
