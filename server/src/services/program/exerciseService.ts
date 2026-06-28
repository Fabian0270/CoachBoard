import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db.js'

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

export async function createExercise(data: {
  workout_id: string
  name?: string
  sets?: string | null
  reps?: string | null
  weight?: number | null
  duration?: number | null
  distance?: number | null
  notes?: string | null
  order_index?: number
  rest_time?: string | null
  intensity?: string | null
  load_used?: string | null
  rpe?: string | null
  group_id?: string | null
}) {
  return getDb()
    .insertInto('exercises')
    .values({
      id: uuidv4(),
      workout_id: data.workout_id,
      name: data.name ?? '',
      sets: data.sets ?? null,
      reps: data.reps ?? null,
      weight: data.weight ?? null,
      duration: data.duration ?? null,
      distance: data.distance ?? null,
      notes: data.notes ?? null,
      order_index: data.order_index ?? 0,
      rest_time: data.rest_time ?? null,
      intensity: data.intensity ?? null,
      load_used: data.load_used ?? null,
      rpe: data.rpe ?? null,
      group_id: data.group_id ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function updateExercise(
  id: string,
  workoutId: string,
  data: {
    name?: string
    sets?: string | null
    reps?: string | null
    weight?: number | null
    duration?: number | null
    distance?: number | null
    notes?: string | null
    order_index?: number
    rest_time?: string | null
    intensity?: string | null
    load_used?: string | null
    rpe?: string | null
    group_id?: string | null
  },
) {
  return getDb()
    .updateTable('exercises')
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.sets !== undefined ? { sets: data.sets ?? null } : {}),
      ...(data.reps !== undefined ? { reps: data.reps ?? null } : {}),
      ...(data.weight !== undefined ? { weight: data.weight ?? null } : {}),
      ...(data.duration !== undefined ? { duration: data.duration ?? null } : {}),
      ...(data.distance !== undefined ? { distance: data.distance ?? null } : {}),
      ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
      ...(data.order_index !== undefined ? { order_index: data.order_index } : {}),
      ...(data.rest_time !== undefined ? { rest_time: data.rest_time ?? null } : {}),
      ...(data.intensity !== undefined ? { intensity: data.intensity ?? null } : {}),
      ...(data.load_used !== undefined ? { load_used: data.load_used ?? null } : {}),
      ...(data.rpe !== undefined ? { rpe: data.rpe ?? null } : {}),
      ...(data.group_id !== undefined ? { group_id: data.group_id ?? null } : {}),
    })
    .where('id', '=', id)
    .where('workout_id', '=', workoutId)
    .returningAll()
    .executeTakeFirst()
}

export async function deleteExercise(id: string, workoutId: string) {
  return getDb()
    .deleteFrom('exercises')
    .where('id', '=', id)
    .where('workout_id', '=', workoutId)
    .returningAll()
    .executeTakeFirst()
}

export async function reorderExercises(workoutId: string, programId: string, exerciseIds: string[]) {
  const db = getDb()
  const workout = await db.selectFrom('workouts').select(['id'])
    .where('id', '=', workoutId).where('program_id', '=', programId).executeTakeFirst()
  if (!workout) return null
  await db.transaction().execute(async (trx) => {
    for (let i = 0; i < exerciseIds.length; i++) {
      await trx.updateTable('exercises').set({ order_index: i })
        .where('id', '=', exerciseIds[i]).where('workout_id', '=', workoutId).execute()
    }
  })
  return db.selectFrom('exercises').selectAll()
    .where('workout_id', '=', workoutId).orderBy('order_index').execute()
}

// ---------------------------------------------------------------------------
// Add set — creates a new exercise in the same group, inserted right after
// the last exercise in that group (other exercises' order_index shifts up).
// ---------------------------------------------------------------------------

export async function addSetToExercise(exerciseId: string, workoutId: string, programId: string) {
  const db = getDb()

  // Validate ownership
  const workout = await db
    .selectFrom('workouts')
    .select(['id'])
    .where('id', '=', workoutId)
    .where('program_id', '=', programId)
    .executeTakeFirst()
  if (!workout) return null

  const source = await db
    .selectFrom('exercises')
    .selectAll()
    .where('id', '=', exerciseId)
    .where('workout_id', '=', workoutId)
    .executeTakeFirst()
  if (!source) return null

  // Get or generate group_id
  let groupId = source.group_id
  if (!groupId) {
    groupId = uuidv4()
    await db
      .updateTable('exercises')
      .set({ group_id: groupId })
      .where('id', '=', exerciseId)
      .execute()
  }

  // Find last order_index in the group
  const allExercises = await db
    .selectFrom('exercises')
    .selectAll()
    .where('workout_id', '=', workoutId)
    .orderBy('order_index')
    .execute()

  let lastGroupIdx = source.order_index
  for (const ex of allExercises) {
    if (ex.group_id === groupId && ex.order_index > lastGroupIdx) {
      lastGroupIdx = ex.order_index
    }
  }

  // Shift subsequent exercises up
  const toShift = allExercises.filter((ex) => ex.order_index > lastGroupIdx)
  if (toShift.length > 0) {
    await db.transaction().execute(async (trx) => {
      for (const ex of toShift) {
        await trx
          .updateTable('exercises')
          .set({ order_index: ex.order_index + 1 })
          .where('id', '=', ex.id)
          .execute()
      }
    })
  }

  // Insert new set
  await db
    .insertInto('exercises')
    .values({
      id: uuidv4(),
      workout_id: workoutId,
      name: source.name,
      sets: null,
      reps: null,
      weight: null,
      duration: null,
      distance: null,
      notes: null,
      order_index: lastGroupIdx + 1,
      rest_time: null,
      intensity: null,
      load_used: null,
      rpe: null,
      group_id: groupId,
    })
    .execute()

  // Return full updated exercise list for this workout
  const exercises = await db
    .selectFrom('exercises')
    .selectAll()
    .where('workout_id', '=', workoutId)
    .orderBy('order_index')
    .execute()

  return { exercises }
}
