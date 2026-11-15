import { v4 as uuidv4 } from 'uuid'
import { sql, type Transaction } from 'kysely'
import { getDb, type DB } from '../../db.js'

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

/**
 * Every exercise name the coach has used, most used first.
 *
 * Feeds the name suggestions in the day editor, where the coach's own names
 * come before the built-in directory. Grouped without regard to case, so
 * "squat" and "Squat" count as one; capped, because it is a suggestion list and
 * not a report.
 */
export async function findExerciseNames(): Promise<{ name: string; uses: number }[]> {
  const result = await sql<{ name: string; uses: number }>`
    SELECT MIN(TRIM(name)) AS name, COUNT(*) AS uses
    FROM exercises
    WHERE TRIM(name) <> ''
    GROUP BY TRIM(name) COLLATE NOCASE
    ORDER BY uses DESC, name COLLATE NOCASE ASC
    LIMIT 500
  `.execute(getDb())
  return result.rows.map((r) => ({ name: r.name, uses: Number(r.uses) }))
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
  // Three writes — group the source, shift everything below, insert the set —
  // that only make sense together. Separately, a failure after the shift left a
  // gap in order_index with no new set to fill it.
  return getDb().transaction().execute((trx) => addSetInTransaction(trx, exerciseId, workoutId, programId))
}

async function addSetInTransaction(
  db: Transaction<DB>,
  exerciseId: string,
  workoutId: string,
  programId: string,
) {
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

  // The last row of the group is what the new set follows — and what it copies.
  let lastRow = source
  for (const ex of allExercises) {
    if (ex.group_id === groupId && ex.order_index > lastRow.order_index) lastRow = ex
  }
  const lastGroupIdx = lastRow.order_index

  // Shift subsequent exercises up
  const toShift = allExercises.filter((ex) => ex.order_index > lastGroupIdx)
  for (const ex of toShift) {
    await db
      .updateTable('exercises')
      .set({ order_index: ex.order_index + 1 })
      .where('id', '=', ex.id)
      .execute()
  }

  // Insert new set
  await db
    .insertInto('exercises')
    .values({
      id: uuidv4(),
      workout_id: workoutId,
      name: source.name,
      // Starts as the set above it. A back-off or top set usually changes one
      // field; an empty row meant retyping all of them every time.
      sets: lastRow.sets,
      reps: lastRow.reps,
      weight: null,
      duration: null,
      distance: null,
      notes: null,
      order_index: lastGroupIdx + 1,
      rest_time: null,
      intensity: lastRow.intensity,
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

// ---------------------------------------------------------------------------
// Duplicate — a copy of the exercise (all of its set rows, if it has several)
// placed directly under it. What the athlete logged is not copied: Load Used
// and RPE belong to the lift that was done, not to the copy.
// ---------------------------------------------------------------------------

export async function duplicateExercise(exerciseId: string, workoutId: string, programId: string) {
  return getDb().transaction().execute(async (db) => {
    const workout = await db
      .selectFrom('workouts')
      .select(['id'])
      .where('id', '=', workoutId)
      .where('program_id', '=', programId)
      .executeTakeFirst()
    if (!workout) return null

    const all = await db
      .selectFrom('exercises')
      .selectAll()
      .where('workout_id', '=', workoutId)
      .orderBy('order_index')
      .execute()
    const source = all.find((ex) => ex.id === exerciseId)
    if (!source) return null

    const rows = source.group_id ? all.filter((ex) => ex.group_id === source.group_id) : [source]
    const lastIdx = Math.max(...rows.map((r) => r.order_index))

    for (const ex of all.filter((e) => e.order_index > lastIdx)) {
      await db
        .updateTable('exercises')
        .set({ order_index: ex.order_index + rows.length })
        .where('id', '=', ex.id)
        .execute()
    }

    const newGroupId = source.group_id ? uuidv4() : null
    const newIds: string[] = []
    for (const [i, row] of rows.entries()) {
      const id = uuidv4()
      newIds.push(id)
      await db
        .insertInto('exercises')
        .values({
          id,
          workout_id: workoutId,
          name: row.name,
          sets: row.sets,
          reps: row.reps,
          weight: row.weight,
          duration: row.duration,
          distance: row.distance,
          notes: row.notes,
          order_index: lastIdx + 1 + i,
          rest_time: row.rest_time,
          intensity: row.intensity,
          load_used: null,
          rpe: null,
          group_id: newGroupId,
        })
        .execute()
    }

    const exercises = await db
      .selectFrom('exercises')
      .selectAll()
      .where('workout_id', '=', workoutId)
      .orderBy('order_index')
      .execute()
    return { exercises, newIds }
  })
}
