import { beforeEach, describe, it, expect } from 'vitest'
import { estimate1RM } from 'coachboard-shared/rpe'
import { initializeDatabase } from '../db.js'
import { createAthlete, createAthleteMax } from './athleteService.js'
import { createProgram, setProgramDuration, createWorkout, createExercise } from './programService.js'
import { getAthleteProgress } from './athleteProgressService.js'

// An athlete's progress across every block (I1).

let athleteId: string
beforeEach(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Anna' })).id
})

async function blockWith(name: string, start: string, days: { date: string; sets: { name: string; reps: string; load: string | null; rpe: string | null }[] }[]) {
  const p = await createProgram({ athlete_id: athleteId, name })
  await setProgramDuration(p.id, start, 4)
  for (const d of days) {
    const w = await createWorkout({ program_id: p.id, name: d.date, scheduled_date: d.date })
    for (const [i, s] of d.sets.entries()) {
      await createExercise({ workout_id: w.id, name: s.name, sets: '3', reps: s.reps, load_used: s.load, rpe: s.rpe, order_index: i })
    }
  }
  return p.id
}
const e1 = (w: number, r: number, rpe: number) => Math.round(estimate1RM(w, r, rpe)! * 10) / 10

describe('getAthleteProgress — e1RM across blocks', () => {
  it('joins the blocks up by date, the best set of each week, competition lifts only', async () => {
    const a = await blockWith('Autumn', '2026-09-07', [
      { date: '2026-09-07', sets: [
        { name: 'Squat', reps: '5', load: '140', rpe: '8' },
        { name: 'Squat', reps: '3', load: '150', rpe: '8' },          // better that week
        { name: 'Pause Squat', reps: '3', load: '160', rpe: '7' },    // a variation: left out
      ] },
      { date: '2026-09-14', sets: [{ name: 'Bench', reps: '5', load: '90', rpe: '8' }] },
    ])
    const b = await blockWith('Winter', '2026-10-05', [
      { date: '2026-10-07', sets: [
        { name: 'Back Squat', reps: '3', load: '155', rpe: '8' },
        { name: 'Deadlift', reps: '5', load: null, rpe: '8' },        // not logged: left out
      ] },
    ])
    const progress = (await getAthleteProgress(athleteId))!
    expect(progress.e1rm.map((l) => l.liftKey)).toEqual(['squat', 'bench'])
    expect(progress.e1rm[0].points.map((p) => [p.week, p.date, p.e1rm, p.exerciseName, p.programId])).toEqual([
      ['2026-09-07', '2026-09-07', e1(150, 3, 8), 'Squat', a],
      ['2026-10-05', '2026-10-07', e1(155, 3, 8), 'Back Squat', b],
    ])
    expect(progress.e1rm[0].points[1].programName).toBe('Winter')
  })

  it('is empty, not missing, for an athlete with nothing logged; null for no athlete', async () => {
    expect(await getAthleteProgress(athleteId)).toEqual({ e1rm: [], prs: [] })
    expect(await getAthleteProgress('00000000-0000-4000-8000-000000000000')).toBeNull()
  })
})

describe('getAthleteProgress — PR timeline', () => {
  it('keeps each max that beat every earlier one for its lift, newest first', async () => {
    const max = (lift_name: string, weight: number, recorded_at: string) =>
      createAthleteMax({ athlete_id: athleteId, lift_name, weight, unit: 'kg', recorded_at, notes: null })
    await max('Squat', 180, '2026-01-10')
    await max('Squat', 175, '2026-03-01')         // not a PR
    await max('Back Squat', 190, '2026-05-01')    // the same lift, a PR
    await max('Pause Squat', 160, '2026-05-02')   // its own lift
    await max('Bench Press', 120, '2026-02-01')
    const { prs } = (await getAthleteProgress(athleteId))!
    expect(prs.map((p) => [p.date, p.liftName, p.weight, p.previous])).toEqual([
      ['2026-05-02', 'Pause Squat', 160, null],
      ['2026-05-01', 'Back Squat', 190, 180],
      ['2026-02-01', 'Bench Press', 120, null],
      ['2026-01-10', 'Squat', 180, null],
    ])
  })
})
