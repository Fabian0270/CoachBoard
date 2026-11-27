import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase, getDb } from '../../db.js'
import { createAthlete } from '../athleteService.js'
import {
  createProgram,
  createWorkout,
  createExercise,
  deleteWorkout,
  deleteExercise,
  copyWorkoutDay,
  moveWorkoutDay,
  findProgramById,
  restoreDays,
  restoreExercises,
  renameExerciseInProgram,
} from '../programService.js'
import type { RestoredDay } from './workoutService.js'

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Test Athlete' })).id
})

const MON = '2026-01-05'
const WED = '2026-01-07'

/** A program with Squat + Rows on Monday (with athlete results) and Bench on Wednesday. */
const seed = async (name: string) => {
  const p = await createProgram({ athlete_id: athleteId, name, start_date: MON, end_date: '2026-01-18' })
  const mon = await createWorkout({ program_id: p.id, name: MON, scheduled_date: MON, notes: 'brace hard' })
  await createExercise({ workout_id: mon.id, name: 'Squat', sets: '5', reps: '5', load_used: '140', rpe: '8', order_index: 0 })
  await createExercise({ workout_id: mon.id, name: 'Rows', sets: '3', reps: '10', order_index: 1 })
  const wed = await createWorkout({ program_id: p.id, name: WED, scheduled_date: WED })
  await createExercise({ workout_id: wed.id, name: 'Bench', sets: '4', reps: '6', order_index: 0 })
  return p
}

/** What the page would snapshot before an action: the day as the API returned it. */
const snapshot = async (programId: string, date: string): Promise<RestoredDay> => {
  const program = await findProgramById(programId)
  const w = program!.workouts.find((x) => x.scheduled_date === date)
  return { date, workout: w ? { id: w.id, name: w.name, notes: w.notes, completed_at: w.completed_at, created_at: w.created_at, exercises: w.exercises } : null }
}

/** The day reduced to what matters for comparing before and after. */
const view = async (programId: string, date: string) => {
  const program = await findProgramById(programId)
  const w = program!.workouts.find((x) => x.scheduled_date === date)
  return w ? { id: w.id, notes: w.notes, rows: w.exercises.map((e) => `${e.id}|${e.name}|${e.sets}|${e.reps}|${e.load_used}|${e.rpe}|${e.order_index}`) } : null
}

describe('restoreDays — undo', () => {
  it('brings a cleared day back with the same ids and the athlete’s results', async () => {
    const p = await seed('Undo clear')
    const before = await view(p.id, MON)
    const snap = await snapshot(p.id, MON)

    await deleteWorkout(snap.workout!.id, p.id)
    expect(await view(p.id, MON)).toBeNull()

    expect(await restoreDays(p.id, [snap])).toBe(true)
    expect(await view(p.id, MON)).toEqual(before)
  })

  it('undoes a copy that replaced a day, results included', async () => {
    const p = await seed('Undo copy')
    const before = await view(p.id, MON)
    const snap = await snapshot(p.id, MON)

    // Copying Wednesday onto Monday erases Monday's exercises and results.
    await copyWorkoutDay(p.id, WED, [MON])
    expect((await view(p.id, MON))!.rows.join()).not.toContain('140')

    await restoreDays(p.id, [snap])
    expect(await view(p.id, MON)).toEqual(before)
  })

  it('undoes a copy onto an empty day by emptying it again', async () => {
    const p = await seed('Undo copy to empty')
    const FRI = '2026-01-09'
    const snap = await snapshot(p.id, FRI)
    expect(snap.workout).toBeNull()

    await copyWorkoutDay(p.id, MON, [FRI])
    expect(await view(p.id, FRI)).not.toBeNull()

    await restoreDays(p.id, [snap])
    expect(await view(p.id, FRI)).toBeNull()
  })

  it('undoes a swap of two days', async () => {
    const p = await seed('Undo swap')
    const mon = await view(p.id, MON)
    const wed = await view(p.id, WED)
    const snaps = [await snapshot(p.id, MON), await snapshot(p.id, WED)]

    await moveWorkoutDay(p.id, MON, WED)
    expect((await view(p.id, MON))!.id).toBe(wed!.id)

    // The moved days keep their ids, so a restore that wrote as it went would
    // collide with them. See the two passes in restoreDays.
    await restoreDays(p.id, snaps)
    expect(await view(p.id, MON)).toEqual(mon)
    expect(await view(p.id, WED)).toEqual(wed)
  })

  it('undoes a cut-and-paste that replaced the target', async () => {
    const p = await seed('Undo replace')
    const mon = await view(p.id, MON)
    const wed = await view(p.id, WED)
    const snaps = [await snapshot(p.id, MON), await snapshot(p.id, WED)]

    await moveWorkoutDay(p.id, MON, WED, true)
    expect(await view(p.id, MON)).toBeNull()
    // The move carries the athlete's results with it — it is the same day.
    expect((await view(p.id, WED))!.rows.join()).toContain('140')

    await restoreDays(p.id, snaps)
    expect(await view(p.id, MON)).toEqual(mon)
    expect(await view(p.id, WED)).toEqual(wed)
  })

  it('says so when the program is gone', async () => {
    expect(await restoreDays('00000000-0000-4000-8000-000000000000', [{ date: MON, workout: null }])).toBe(false)
  })

  it('leaves other days of the program alone', async () => {
    const p = await seed('Undo scope')
    const wed = await view(p.id, WED)
    const snap = await snapshot(p.id, MON)
    await deleteWorkout(snap.workout!.id, p.id)
    await restoreDays(p.id, [snap])
    expect(await view(p.id, WED)).toEqual(wed)
  })
})

describe('restoreExercises — undo of a deleted exercise', () => {
  it('puts the exercise back where it was, without touching the rest of the day', async () => {
    const p = await seed('Undo delete')
    const snap = await snapshot(p.id, MON)
    const squat = snap.workout!.exercises[0]

    await deleteExercise(squat.id, snap.workout!.id)
    // Meanwhile the coach edits the other row; an undo must not roll that back.
    await getDb().updateTable('exercises').set({ reps: '12' }).where('id', '=', snap.workout!.exercises[1].id).execute()

    const rows = await restoreExercises(p.id, snap.workout!.id, [squat])
    expect(rows!.map((e) => `${e.name}|${e.reps}|${e.load_used}`)).toEqual(['Squat|5|140', 'Rows|12|null'])
    expect(rows![0].id).toBe(squat.id)
  })

  it('answers null when the day itself is gone', async () => {
    const p = await seed('Undo delete, day gone')
    const snap = await snapshot(p.id, MON)
    await deleteWorkout(snap.workout!.id, p.id)
    expect(await restoreExercises(p.id, snap.workout!.id, [snap.workout!.exercises[0]])).toBeNull()
  })
})

describe('renameExerciseInProgram — replace an exercise across the block', () => {
  it('renames it on every day, ignoring case and spaces, and keeps everything else', async () => {
    const p = await seed('Rename')
    const wed = (await findProgramById(p.id))!.workouts.find((w) => w.scheduled_date === WED)!
    await createExercise({ workout_id: wed.id, name: ' squat ', sets: '3', reps: '3', order_index: 1 })

    const res = await renameExerciseInProgram(p.id, 'Squat', 'Pause Squat')
    expect(res).toEqual({ renamed: 2, dates: [MON, WED] })
    const program = await findProgramById(p.id)
    const names = program!.workouts.flatMap((w) => w.exercises.map((e) => `${e.name}|${e.load_used}`)).sort()
    // Monday's logged result stays with the renamed row.
    expect(names).toEqual(['Bench|null', 'Pause Squat|140', 'Pause Squat|null', 'Rows|null'])
  })

  it('only from the given date on', async () => {
    const p = await seed('Rename from')
    const wed = (await findProgramById(p.id))!.workouts.find((w) => w.scheduled_date === WED)!
    await createExercise({ workout_id: wed.id, name: 'Squat', order_index: 1 })
    expect(await renameExerciseInProgram(p.id, 'Squat', 'Box Squat', WED)).toEqual({ renamed: 1, dates: [WED] })
  })

  it('answers null for a program that is gone', async () => {
    expect(await renameExerciseInProgram('00000000-0000-4000-8000-000000000000', 'a', 'b')).toBeNull()
  })
})

describe('moveWorkoutDay', () => {
  it('swaps with an occupied target by default, and replaces it when asked', async () => {
    const p = await seed('Move')
    const monId = (await view(p.id, MON))!.id
    const wedId = (await view(p.id, WED))!.id

    await moveWorkoutDay(p.id, MON, WED)
    expect((await view(p.id, WED))!.id).toBe(monId)
    expect((await view(p.id, MON))!.id).toBe(wedId)

    await moveWorkoutDay(p.id, WED, MON, true)
    expect((await view(p.id, MON))!.id).toBe(monId)
    expect(await view(p.id, WED)).toBeNull()
  })
})
