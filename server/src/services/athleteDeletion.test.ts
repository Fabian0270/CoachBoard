import { beforeEach, describe, it, expect } from 'vitest'
import { initializeDatabase, getDb } from '../db.js'
import {
  createAthlete,
  createAthleteMax,
  deleteAthlete,
  deleteAthleteKeepingPrograms,
} from './athleteService.js'
import { createProgram, createWorkout, createExercise, updateProgram, findAllPrograms } from './programService.js'
import { createPayment } from './paymentService.js'

// Build an athlete with a full program (workout + exercise), one PR and one payment.
async function seedAthlete(name: string) {
  const athlete = await createAthlete({ name })
  const program = await createProgram({ athlete_id: athlete.id, name: `${name}'s block`, status: 'completed' })
  const workout = await createWorkout({ program_id: program.id, name: 'Day 1', scheduled_date: '2026-01-05' })
  await createExercise({ workout_id: workout.id, name: 'Squat', sets: '3', reps: '5' })
  await createAthleteMax({ athlete_id: athlete.id, lift_name: 'Squat', weight: 200 })
  await createPayment({ athlete_id: athlete.id, amount: 100, currency: 'SEK', paid_through: '2026-02-01' })
  return { athlete, program, workout }
}

beforeEach(async () => {
  await initializeDatabase(':memory:')
})

describe('deleteAthlete (full delete)', () => {
  it('cascade-deletes the athlete and all their programs/workouts/exercises', async () => {
    const { athlete, workout } = await seedAthlete('Cascade Cathy')
    const deleted = await deleteAthlete(athlete.id)
    expect(deleted?.id).toBe(athlete.id)

    expect(await findAllPrograms(athlete.id)).toHaveLength(0)
    const programsLeft = await getDb().selectFrom('programs').selectAll().execute()
    expect(programsLeft).toHaveLength(0)
    const workoutsLeft = await getDb().selectFrom('workouts').selectAll().where('id', '=', workout.id).execute()
    expect(workoutsLeft).toHaveLength(0)
    const exercisesLeft = await getDb().selectFrom('exercises').selectAll().execute()
    expect(exercisesLeft).toHaveLength(0)
  })
})

describe('deleteAthleteKeepingPrograms (keep programs)', () => {
  it('detaches + archives the programs but deletes the athlete, maxes and payments', async () => {
    const { athlete, program, workout } = await seedAthlete('Keeper Kate')
    const deleted = await deleteAthleteKeepingPrograms(athlete.id)
    expect(deleted?.id).toBe(athlete.id)

    // Athlete row is gone…
    const athleteRow = await getDb().selectFrom('athletes').selectAll().where('id', '=', athlete.id).execute()
    expect(athleteRow).toHaveLength(0)
    // …along with their maxes and payments.
    expect(await getDb().selectFrom('athlete_maxes').selectAll().where('athlete_id', '=', athlete.id).execute()).toHaveLength(0)
    expect(await getDb().selectFrom('payments').selectAll().where('athlete_id', '=', athlete.id).execute()).toHaveLength(0)

    // The program survives, detached (athlete_id NULL) and archived…
    const kept = await getDb().selectFrom('programs').selectAll().where('id', '=', program.id).executeTakeFirst()
    expect(kept).toBeDefined()
    expect(kept?.athlete_id).toBeNull()
    expect(kept?.status).toBe('archived')
    // …with its workouts and exercises intact.
    expect(await getDb().selectFrom('workouts').selectAll().where('id', '=', workout.id).execute()).toHaveLength(1)
    expect(await getDb().selectFrom('exercises').selectAll().execute()).toHaveLength(1)
  })

  it('returns undefined for a missing athlete and touches nothing', async () => {
    const { program } = await seedAthlete('Untouched Uma')
    const result = await deleteAthleteKeepingPrograms('00000000-0000-0000-0000-000000000000')
    expect(result).toBeUndefined()
    const stillThere = await getDb().selectFrom('programs').selectAll().where('id', '=', program.id).executeTakeFirst()
    expect(stillThere?.athlete_id).not.toBeNull()
  })
})

describe('reassigning an unassigned program', () => {
  it('updateProgram can attach a detached program to another athlete', async () => {
    const { athlete, program } = await seedAthlete('Donor Dana')
    await deleteAthleteKeepingPrograms(athlete.id)

    const newOwner = await createAthlete({ name: 'New Owner Ned' })
    const updated = await updateProgram(program.id, { athlete_id: newOwner.id })
    expect(updated?.athlete_id).toBe(newOwner.id)

    // It now lists under the new owner.
    const ownerPrograms = await findAllPrograms(newOwner.id)
    expect(ownerPrograms.map((p) => p.id)).toContain(program.id)
  })
})
