import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  serializeEnabledColumns,
  withParsedColumns,
  createProgram,
  updateProgram,
  setProgramDuration,
  findProgramById,
  createWorkout,
  createExercise,
} from './programService.js'

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const athlete = await createAthlete({ name: 'Test Athlete' })
  athleteId = athlete.id
})

describe('serializeEnabledColumns', () => {
  it('serializes a valid array', () => {
    expect(serializeEnabledColumns(['rest_time', 'rpe'])).toBe('["rest_time","rpe"]')
  })

  it('filters out unknown column names', () => {
    expect(serializeEnabledColumns(['rest_time', 'bogus'])).toBe('["rest_time"]')
  })

  it('returns null for null/undefined/non-arrays', () => {
    expect(serializeEnabledColumns(null)).toBeNull()
    expect(serializeEnabledColumns(undefined)).toBeNull()
    expect(serializeEnabledColumns('rest_time')).toBeNull()
  })
})

describe('withParsedColumns', () => {
  it('parses a stored JSON array', () => {
    const p = withParsedColumns({ enabled_columns: '["rpe","intensity"]' })
    expect(p.enabled_columns).toEqual(['rpe', 'intensity'])
  })

  it('returns null for invalid JSON', () => {
    expect(withParsedColumns({ enabled_columns: 'not json' }).enabled_columns).toBeNull()
  })

  it('returns null for null input', () => {
    expect(withParsedColumns({ enabled_columns: null }).enabled_columns).toBeNull()
  })
})

describe('createProgram / updateProgram', () => {
  it('round-trips enabled_columns as a parsed array', async () => {
    const program = await createProgram({
      athlete_id: athleteId,
      name: 'Strength block',
      enabled_columns: ['rest_time', 'rpe'],
    })
    expect(program.enabled_columns).toEqual(['rest_time', 'rpe'])

    const updated = await updateProgram(program.id, { enabled_columns: ['intensity'] })
    expect(updated?.enabled_columns).toEqual(['intensity'])
  })

  it('returns undefined when updating a missing program', async () => {
    expect(await updateProgram('00000000-0000-0000-0000-000000000000', { name: 'x' })).toBeUndefined()
  })
})

describe('setProgramDuration', () => {
  it('normalizes the start date to Monday and computes the end date', async () => {
    const program = await createProgram({ athlete_id: athleteId, name: 'Duration test' })
    // 2026-06-13 is a Saturday; the containing week starts Monday 2026-06-08.
    const updated = await setProgramDuration(program.id, '2026-06-13', 4)
    expect(updated?.start_date).toBe('2026-06-08')
    expect(updated?.end_date).toBe('2026-07-05') // 4 weeks − 1 day
  })

  it('returns enabled_columns parsed, like every other endpoint', async () => {
    const program = await createProgram({
      athlete_id: athleteId,
      name: 'Parsed columns test',
      enabled_columns: ['rpe'],
    })
    const updated = await setProgramDuration(program.id, '2026-06-08', 1)
    // Regression: this used to come back as the raw JSON string '["rpe"]'.
    expect(updated?.enabled_columns).toEqual(['rpe'])
  })

  it('returns undefined for a missing program', async () => {
    expect(await setProgramDuration('00000000-0000-0000-0000-000000000000', '2026-06-08', 1)).toBeUndefined()
  })
})

describe('findProgramById', () => {
  it('nests workouts and exercises', async () => {
    const program = await createProgram({ athlete_id: athleteId, name: 'Nesting test' })
    const workout = await createWorkout({ program_id: program.id, name: '2026-06-08', scheduled_date: '2026-06-08' })
    await createExercise({ workout_id: workout.id, name: 'Squat', sets: '3', reps: '5', order_index: 0 })
    await createExercise({ workout_id: workout.id, name: 'Bench', sets: '3', reps: '8', order_index: 1 })

    const found = await findProgramById(program.id)
    expect(found?.workouts).toHaveLength(1)
    expect(found?.workouts[0].exercises.map((e) => e.name)).toEqual(['Squat', 'Bench'])
  })
})

describe('foreign key cascades', () => {
  it('deleting an athlete removes their programs, workouts and exercises', async () => {
    const athlete = await createAthlete({ name: 'Cascade Test' })
    const program = await createProgram({ athlete_id: athlete.id, name: 'Doomed' })
    const workout = await createWorkout({ program_id: program.id, name: 'w' })
    await createExercise({ workout_id: workout.id, name: 'e' })

    await getDb().deleteFrom('athletes').where('id', '=', athlete.id).execute()

    const programs = await getDb().selectFrom('programs').selectAll().where('athlete_id', '=', athlete.id).execute()
    const workouts = await getDb().selectFrom('workouts').selectAll().where('program_id', '=', program.id).execute()
    const exercises = await getDb().selectFrom('exercises').selectAll().where('workout_id', '=', workout.id).execute()
    expect(programs).toHaveLength(0)
    expect(workouts).toHaveLength(0)
    expect(exercises).toHaveLength(0)
  })
})
