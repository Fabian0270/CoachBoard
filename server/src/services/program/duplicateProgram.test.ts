import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase, getDb } from '../../db.js'
import { createAthlete } from '../athleteService.js'
import { createProgram, createWorkout, createExercise, addSetToExercise, findProgramById } from '../programService.js'
import { duplicateProgram } from './duplicateProgram.js'

let sara: string
let tom: string
let noMaxes: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  sara = (await createAthlete({ name: 'Sara' })).id
  tom = (await createAthlete({ name: 'Tom' })).id
  noMaxes = (await createAthlete({ name: 'New' })).id
  const max = (athlete_id: string, lift_name: string, weight: number) =>
    getDb().insertInto('athlete_maxes').values({ id: crypto.randomUUID(), athlete_id, lift_name, weight, unit: 'kg', recorded_at: '2026-06-01', notes: null }).execute()
  await max(sara, 'Squat', 200)
  await max(tom, 'Squat', 150)
  await max(sara, 'Bench Press', 120)
})

/** Sara's two-week block: Squat with a load and her results, a set row, Rows; a note. */
const block = async () => {
  const p = await createProgram({
    athlete_id: sara, name: 'Sara block', start_date: '2026-06-15', end_date: '2026-06-28',
    focus: 'strength', enabled_columns: ['intensity', 'load_cap'],
  })
  const w1 = await createWorkout({ program_id: p.id, name: '2026-06-15', scheduled_date: '2026-06-15', notes: 'brace' })
  const sq = await createExercise({ workout_id: w1.id, name: 'Squat', sets: '1', reps: '3', weight: 170, intensity: 'RPE 8', load_used: '170', rpe: '8', order_index: 0 })
  await addSetToExercise(sq.id, w1.id, p.id)
  await createExercise({ workout_id: w1.id, name: 'Rows', sets: '3', reps: '10', weight: 60, order_index: 2 })
  const w2 = await createWorkout({ program_id: p.id, name: 'Heavy day', scheduled_date: '2026-06-24' })
  await createExercise({ workout_id: w2.id, name: 'Bench Press', sets: '5', reps: '5', weight: 100, order_index: 0 })
  return p
}

describe('duplicateProgram', () => {
  it('copies the whole block to a new start, without the results unless asked', async () => {
    const src = await block()
    const res = await duplicateProgram(src.id, { athleteId: sara, name: 'Sara block 2', startDate: '2026-07-01', keepResults: false, scaleLoads: false })
    const copy = (await findProgramById(res!.id))!
    // Wednesday 1 July → that week's Monday; same two weeks long.
    expect([copy.start_date, copy.end_date]).toEqual(['2026-06-29', '2026-07-12'])
    expect(copy).toMatchObject({ name: 'Sara block 2', focus: 'strength', athlete_id: sara, status: 'active' })
    expect(copy.enabled_columns).toEqual(['intensity', 'load_cap'])

    const days = copy.workouts.map((w) => [w.scheduled_date, w.name, w.notes]).sort()
    // Named-after-its-date follows the date; a coach's own name stays.
    expect(days).toEqual([['2026-06-29', '2026-06-29', 'brace'], ['2026-07-08', 'Heavy day', null]])
    const mon = copy.workouts.find((w) => w.scheduled_date === '2026-06-29')!
    expect(mon.exercises.map((e) => `${e.name}|${e.weight}|${e.load_used}|${e.rpe}`)).toEqual(['Squat|170|null|null', 'Squat|null|null|null', 'Rows|60|null|null'])
    // The set row is still grouped with its exercise, under a new group.
    expect(mon.exercises[0].group_id).toBeTruthy()
    expect(mon.exercises[0].group_id).toBe(mon.exercises[1].group_id)
    const srcMon = (await findProgramById(src.id))!.workouts.find((w) => w.scheduled_date === '2026-06-15')!
    expect(mon.exercises[0].group_id).not.toBe(srcMon.exercises[0].group_id)
    // The source is untouched.
    expect(srcMon.exercises[0].load_used).toBe('170')
  })

  it('keeps the results when asked', async () => {
    const src = await block()
    const res = await duplicateProgram(src.id, { athleteId: sara, name: 'c', startDate: '2026-06-15', keepResults: true, scaleLoads: false })
    const copy = (await findProgramById(res!.id))!
    expect(copy.workouts.flatMap((w) => w.exercises).find((e) => e.load_used)?.load_used).toBe('170')
  })

  it("scales main-lift loads to the new athlete's maxes, and says what it could not scale", async () => {
    const src = await block()
    const res = await duplicateProgram(src.id, { athleteId: tom, name: 'Tom block', startDate: '2026-07-06', keepResults: false, scaleLoads: true })
    const copy = (await findProgramById(res!.id))!
    const all = copy.workouts.flatMap((w) => w.exercises)
    // 170 × 150 / 200 = 127.5. Rows is not a main lift and keeps its 60.
    expect(all.find((e) => e.name === 'Squat' && e.weight != null)?.weight).toBe(127.5)
    expect(all.find((e) => e.name === 'Rows')?.weight).toBe(60)
    // Tom has no bench max: the bench load stays and is counted as not scaled.
    expect(all.find((e) => e.name === 'Bench Press')?.weight).toBe(100)
    expect(res).toMatchObject({ scaled: 1, notScaled: 1 })
  })

  it('keeps every load for an athlete with no maxes at all', async () => {
    const src = await block()
    const res = await duplicateProgram(src.id, { athleteId: noMaxes, name: 'x', startDate: '2026-07-06', keepResults: false, scaleLoads: true })
    expect(res).toMatchObject({ scaled: 0, notScaled: 2 })
  })

  it('saves a template with no athlete', async () => {
    const src = await block()
    const res = await duplicateProgram(src.id, { athleteId: null, name: 'Strength template', startDate: '2026-06-15', keepResults: false, scaleLoads: false })
    expect((await findProgramById(res!.id))!.athlete_id).toBeNull()
  })

  it('a template can also be created directly, with no athlete', async () => {
    const t = await createProgram({ athlete_id: null, name: 'Peaking template', start_date: '2026-06-15', end_date: '2026-06-28' })
    expect(t.athlete_id).toBeNull()
    const { schemas } = await import('../../validation.js')
    expect(schemas.program.create.safeParse({ athlete_id: null, name: 'T' }).success).toBe(true)
    expect(schemas.program.create.safeParse({ name: 'T' }).success).toBe(false)
  })

  it('answers null for a program that is gone', async () => {
    expect(await duplicateProgram('00000000-0000-4000-8000-000000000000', { athleteId: null, name: 'x', startDate: '2026-06-15', keepResults: false, scaleLoads: false })).toBeNull()
  })
})
