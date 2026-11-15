import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase } from '../../db.js'
import { createAthlete } from '../athleteService.js'
import {
  createProgram,
  createWorkout,
  createExercise,
  addSetToExercise,
  duplicateExercise,
} from '../programService.js'

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Test Athlete' })).id
})

const day = async (name: string) => {
  const p = await createProgram({ athlete_id: athleteId, name })
  const w = await createWorkout({ program_id: p.id, name: 'd', scheduled_date: '2026-01-05' })
  return { p, w }
}

describe('addSetToExercise', () => {
  it('starts the new set as a copy of the set above it', async () => {
    const { p, w } = await day('Sets')
    const ex = await createExercise({
      workout_id: w.id, name: 'Squat', sets: '1', reps: '3', intensity: 'RPE 8', weight: 150,
      rest_time: '3', load_used: '150', rpe: '8', order_index: 0,
    })
    await createExercise({ workout_id: w.id, name: 'Rows', order_index: 1 })

    const res = await addSetToExercise(ex.id, w.id, p.id)
    const added = res!.exercises[1]
    expect(added).toMatchObject({ name: 'Squat', sets: '1', reps: '3', intensity: 'RPE 8', order_index: 1 })
    // Not the load cap, and nothing the athlete logged.
    expect(added).toMatchObject({ weight: null, load_used: null, rpe: null })
    expect(added.group_id).toBe(res!.exercises[0].group_id)
    expect(res!.exercises.map((e) => e.name)).toEqual(['Squat', 'Squat', 'Rows'])
  })

  it('copies the LAST set of the group, not the first', async () => {
    const { p, w } = await day('Sets 2')
    const ex = await createExercise({ workout_id: w.id, name: 'Bench', sets: '1', reps: '3', order_index: 0 })
    const first = await addSetToExercise(ex.id, w.id, p.id)
    // The coach makes the second row a back-off set…
    const backOff = first!.exercises[1]
    const { updateExercise } = await import('../programService.js')
    await updateExercise(backOff.id, w.id, { sets: '3', reps: '6' })
    // …and a third set then starts from that one.
    const second = await addSetToExercise(ex.id, w.id, p.id)
    expect(second!.exercises[2]).toMatchObject({ sets: '3', reps: '6' })
  })
})

describe('findExerciseNames', () => {
  it('lists the names in use, most used first, ignoring case and blanks', async () => {
    const { w } = await day('Names')
    for (const name of ['Zercher Carry', 'zercher carry', 'ZERCHER CARRY', 'Yoke Walk', '', '   ']) {
      await createExercise({ workout_id: w.id, name, order_index: 0 })
    }
    const { findExerciseNames } = await import('../programService.js')
    const names = await findExerciseNames()
    const zercher = names.find((n) => n.name.toLowerCase() === 'zercher carry')
    const yoke = names.find((n) => n.name === 'Yoke Walk')
    expect(zercher?.uses).toBe(3)
    expect(yoke?.uses).toBe(1)
    expect(names.indexOf(zercher!)).toBeLessThan(names.indexOf(yoke!))
    expect(names.some((n) => n.name.trim() === '')).toBe(false)
    // One entry per name, however it was capitalised.
    expect(names.filter((n) => n.name.toLowerCase() === 'zercher carry')).toHaveLength(1)
  })
})

describe('duplicateExercise', () => {
  it("copies a single exercise directly under it, without the athlete's results", async () => {
    const { p, w } = await day('Dup')
    const a = await createExercise({
      workout_id: w.id, name: 'Squat', sets: '5', reps: '5', intensity: 'RPE 8',
      load_used: '140', rpe: '8', order_index: 0,
    })
    await createExercise({ workout_id: w.id, name: 'Rows', order_index: 1 })

    const res = await duplicateExercise(a.id, w.id, p.id)
    expect(res!.exercises.map((e) => e.name)).toEqual(['Squat', 'Squat', 'Rows'])
    expect(res!.exercises.map((e) => e.order_index)).toEqual([0, 1, 2])
    const copy = res!.exercises[1]
    expect(copy.id).toBe(res!.newIds[0])
    expect(copy).toMatchObject({ sets: '5', reps: '5', intensity: 'RPE 8', load_used: null, rpe: null, group_id: null })
    // The original keeps what the athlete logged.
    expect(res!.exercises[0]).toMatchObject({ load_used: '140', rpe: '8' })
  })

  it('copies every set row of a grouped exercise, as its own group', async () => {
    const { p, w } = await day('Dup group')
    const a = await createExercise({ workout_id: w.id, name: 'Bench', sets: '1', reps: '3', order_index: 0 })
    await createExercise({ workout_id: w.id, name: 'Rows', order_index: 1 })
    await addSetToExercise(a.id, w.id, p.id)

    const res = await duplicateExercise(a.id, w.id, p.id)
    expect(res!.exercises.map((e) => e.name)).toEqual(['Bench', 'Bench', 'Bench', 'Bench', 'Rows'])
    expect(res!.exercises.map((e) => e.order_index)).toEqual([0, 1, 2, 3, 4])
    const [o1, o2, c1, c2] = res!.exercises
    expect(o1.group_id).toBe(o2.group_id)
    expect(c1.group_id).toBe(c2.group_id)
    expect(c1.group_id).not.toBe(o1.group_id)
    expect(res!.newIds).toEqual([c1.id, c2.id])
  })

  it('refuses an exercise that is not in that program', async () => {
    const { w } = await day('Mine')
    const other = await createProgram({ athlete_id: athleteId, name: 'Other' })
    const a = await createExercise({ workout_id: w.id, name: 'Squat', order_index: 0 })
    expect(await duplicateExercise(a.id, w.id, other.id)).toBeNull()
  })
})
