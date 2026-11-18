import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { initializeDatabase, getDb } from '../../db.js'
import { configureSecureStore } from '../secureStore.js'
import { createExercise, updateExercise, addSetToExercise, duplicateExercise, pasteExercises } from './exerciseService.js'
import { copyWorkoutDay, restoreExercises } from './workoutService.js'
import { duplicateProgram } from './duplicateProgram.js'

// BP39 (D71): the row's velocity target is planning, not a result — it goes
// wherever the row's plan goes.

let tmpDir: string
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-velocity-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})
afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const now = () => new Date().toISOString()

async function program() {
  const db = getDb()
  const programId = uuidv4()
  const workoutId = uuidv4()
  await db.insertInto('programs').values({
    id: programId, athlete_id: null, name: 'Block', description: null, start_date: '2026-11-16', end_date: '2026-11-29',
    status: 'active', created_at: now(), updated_at: now(), enabled_columns: null, focus: null, export_layout: null,
    export_template_sha: null, builtin_template: 'coachboard',
  }).execute()
  await db.insertInto('workouts').values({
    id: workoutId, program_id: programId, name: 'Day', scheduled_date: '2026-11-17', completed_at: null, notes: null, created_at: now(),
  }).execute()
  const ex = await createExercise({ workout_id: workoutId, name: 'Squat', sets: '3', reps: '3', velocity: '0.50 · VL 20%' })
  return { programId, workoutId, ex }
}

const velocities = (workoutId: string) =>
  getDb().selectFrom('exercises').select('velocity').where('workout_id', '=', workoutId).orderBy('order_index').execute()
    .then((rows) => rows.map((r) => r.velocity))

describe('the velocity target', () => {
  it('is stored, changed and cleared', async () => {
    const { workoutId, ex } = await program()
    expect(ex.velocity).toBe('0.50 · VL 20%')
    expect((await updateExercise(ex.id, workoutId, { velocity: '0.45-0.55' }))?.velocity).toBe('0.45-0.55')
    expect((await updateExercise(ex.id, workoutId, { velocity: null }))?.velocity).toBeNull()
  })

  it('a new set, a duplicate and a pasted row carry it', async () => {
    const { programId, workoutId, ex } = await program()
    await addSetToExercise(ex.id, workoutId, programId)
    await duplicateExercise(ex.id, workoutId, programId)
    await pasteExercises(workoutId, programId, null, null, [{ name: 'Bench', velocity: 'VL 15%' }])
    expect(await velocities(workoutId)).toEqual(['0.50 · VL 20%', '0.50 · VL 20%', '0.50 · VL 20%', '0.50 · VL 20%', 'VL 15%'])
  })

  it('copying the day carries it; undo puts it back', async () => {
    const { programId, workoutId, ex } = await program()
    await copyWorkoutDay(programId, '2026-11-17', ['2026-11-24'])
    const copy = await getDb().selectFrom('workouts').select('id').where('scheduled_date', '=', '2026-11-24').executeTakeFirstOrThrow()
    expect(await velocities(copy.id)).toEqual(['0.50 · VL 20%'])
    await getDb().deleteFrom('exercises').where('id', '=', ex.id).execute()
    await restoreExercises(programId, workoutId, [{ ...ex, order_index: 0 }])
    expect(await velocities(workoutId)).toEqual(['0.50 · VL 20%'])
  })

  it('a duplicated program keeps it, results or not', async () => {
    const { programId } = await program()
    const copy = await duplicateProgram(programId, { athleteId: null, name: 'Copy', startDate: '2026-12-07', keepResults: false, scaleLoads: false })
    const w = await getDb().selectFrom('workouts').select('id').where('program_id', '=', copy!.id).executeTakeFirstOrThrow()
    expect(await velocities(w.id)).toEqual(['0.50 · VL 20%'])
  })
})
