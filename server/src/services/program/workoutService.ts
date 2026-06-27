import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db.js'

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

export async function createWorkout(data: {
  program_id: string
  name: string
  scheduled_date?: string | null
  notes?: string | null
}) {
  return getDb()
    .insertInto('workouts')
    .values({
      id: uuidv4(),
      program_id: data.program_id,
      name: data.name,
      scheduled_date: data.scheduled_date ?? null,
      notes: data.notes ?? null,
      created_at: new Date().toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function updateWorkout(
  id: string,
  programId: string,
  data: { name?: string; scheduled_date?: string | null; notes?: string | null },
) {
  return getDb()
    .updateTable('workouts')
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.scheduled_date !== undefined ? { scheduled_date: data.scheduled_date ?? null } : {}),
      ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
    })
    .where('id', '=', id)
    .where('program_id', '=', programId)
    .returningAll()
    .executeTakeFirst()
}

export async function deleteWorkout(id: string, programId: string) {
  return getDb()
    .deleteFrom('workouts')
    .where('id', '=', id)
    .where('program_id', '=', programId)
    .returningAll()
    .executeTakeFirst()
}

// ---------------------------------------------------------------------------
// Copy day — copies exercises from sourceDate's workout to each targetDate,
// replacing any existing exercises on those days.
// ---------------------------------------------------------------------------

export async function copyWorkoutDay(
  programId: string,
  sourceDate: string,
  targetDates: string[],
) {
  const db = getDb()

  const sourceWorkout = await db
    .selectFrom('workouts')
    .selectAll()
    .where('program_id', '=', programId)
    .where('scheduled_date', '=', sourceDate)
    .executeTakeFirst()

  if (!sourceWorkout) return { copiedTo: 0 }

  const sourceExercises = await db
    .selectFrom('exercises')
    .selectAll()
    .where('workout_id', '=', sourceWorkout.id)
    .orderBy('order_index')
    .execute()

  if (sourceExercises.length === 0) return { copiedTo: 0 }

  let copiedTo = 0

  for (const targetDate of targetDates) {
    if (targetDate === sourceDate) continue

    await db.transaction().execute(async (trx) => {
      // Find or create target workout
      let targetWorkout = await trx
        .selectFrom('workouts')
        .selectAll()
        .where('program_id', '=', programId)
        .where('scheduled_date', '=', targetDate)
        .executeTakeFirst()

      if (!targetWorkout) {
        targetWorkout = await trx
          .insertInto('workouts')
          .values({
            id: uuidv4(),
            program_id: programId,
            name: targetDate,
            scheduled_date: targetDate,
            notes: null,
            created_at: new Date().toISOString(),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
      } else {
        // Replace existing exercises
        await trx
          .deleteFrom('exercises')
          .where('workout_id', '=', targetWorkout.id)
          .execute()
      }

      // Map old group_ids → new group_ids so sets stay grouped
      const groupIdMap = new Map<string, string>()

      for (const ex of sourceExercises) {
        let newGroupId: string | null = null
        if (ex.group_id) {
          if (!groupIdMap.has(ex.group_id)) groupIdMap.set(ex.group_id, uuidv4())
          newGroupId = groupIdMap.get(ex.group_id)!
        }
        await trx
          .insertInto('exercises')
          .values({
            id: uuidv4(),
            workout_id: targetWorkout!.id,
            name: ex.name,
            sets: ex.sets,
            reps: ex.reps,
            weight: ex.weight,
            duration: ex.duration,
            distance: ex.distance,
            notes: ex.notes,
            order_index: ex.order_index,
            rest_time: ex.rest_time,
            intensity: ex.intensity,
            load_used: null,
            rpe: null,
            group_id: newGroupId,
          })
          .execute()
      }
    })

    copiedTo++
  }

  return { copiedTo }
}

// ---------------------------------------------------------------------------
// Move day — moves a workout to a different date, swapping if target is occupied.
// ---------------------------------------------------------------------------

export async function moveWorkoutDay(programId: string, sourceDate: string, targetDate: string): Promise<void> {
  const db = getDb()

  const sourceWorkout = await db
    .selectFrom('workouts')
    .select(['id'])
    .where('program_id', '=', programId)
    .where('scheduled_date', '=', sourceDate)
    .executeTakeFirst()

  if (!sourceWorkout) throw new Error('No workout on source date')

  const targetWorkout = await db
    .selectFrom('workouts')
    .select(['id'])
    .where('program_id', '=', programId)
    .where('scheduled_date', '=', targetDate)
    .executeTakeFirst()

  await db.transaction().execute(async (trx) => {
    await trx.updateTable('workouts')
      .set({ scheduled_date: targetDate, name: targetDate })
      .where('id', '=', sourceWorkout.id)
      .execute()

    if (targetWorkout) {
      await trx.updateTable('workouts')
        .set({ scheduled_date: sourceDate, name: sourceDate })
        .where('id', '=', targetWorkout.id)
        .execute()
    }
  })
}
