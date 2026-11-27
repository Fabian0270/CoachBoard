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
            velocity: ex.velocity,
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

export async function moveWorkoutDay(
  programId: string,
  sourceDate: string,
  targetDate: string,
  /** Replace an occupied target instead of swapping with it (cut and paste). */
  replace = false,
): Promise<void> {
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
    if (targetWorkout && replace) {
      await trx.deleteFrom('workouts').where('id', '=', targetWorkout.id).execute()
    }

    await trx.updateTable('workouts')
      .set({ scheduled_date: targetDate, name: targetDate })
      .where('id', '=', sourceWorkout.id)
      .execute()

    if (targetWorkout && !replace) {
      await trx.updateTable('workouts')
        .set({ scheduled_date: sourceDate, name: sourceDate })
        .where('id', '=', targetWorkout.id)
        .execute()
    }
  })
}

// ---------------------------------------------------------------------------
// Replace an exercise across the block ("Pin Squat → Pause Squat in every
// week"). Matches the name without regard to case or surrounding spaces, so
// "pin squat" and "Pin Squat " are the same lift. Only the name changes: sets,
// reps, loads and what the athlete logged stay as they are.
// ---------------------------------------------------------------------------

export async function renameExerciseInProgram(
  programId: string,
  from: string,
  to: string,
  fromDate?: string | null,
): Promise<{ renamed: number; dates: string[] } | null> {
  const db = getDb()
  const program = await db.selectFrom('programs').select(['id']).where('id', '=', programId).executeTakeFirst()
  if (!program) return null
  const want = from.trim().toLowerCase()
  const rows = await db
    .selectFrom('exercises')
    .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
    .select(['exercises.id as id', 'exercises.name as name', 'workouts.scheduled_date as date'])
    .where('workouts.program_id', '=', programId)
    .execute()
  const hit = rows.filter((r) => r.name.trim().toLowerCase() === want && (!fromDate || (r.date ?? '') >= fromDate))
  if (hit.length > 0) {
    await db.transaction().execute(async (trx) => {
      for (const r of hit) await trx.updateTable('exercises').set({ name: to.trim() }).where('id', '=', r.id).execute()
    })
  }
  return { renamed: hit.length, dates: [...new Set(hit.map((r) => r.date).filter((d): d is string => !!d))].sort() }
}

// ---------------------------------------------------------------------------
// Undo.
//
// Every destructive action in the program editor (clearing a day, copying or
// pasting over one, moving or swapping days) is undone the same way: the days
// it touched are put back from a snapshot taken just before, ids and all. One
// primitive instead of an inverse per action, so an undo cannot drift out of
// step with the action it reverses.
// ---------------------------------------------------------------------------

export interface RestoredExercise {
  id: string
  name: string
  sets?: string | null
  reps?: string | null
  weight?: number | null
  duration?: number | null
  distance?: number | null
  notes?: string | null
  order_index: number
  rest_time?: string | null
  intensity?: string | null
  load_used?: string | null
  rpe?: string | null
  reps_done?: string | null
  velocity?: string | null
  group_id?: string | null
  suggestion_note?: string | null
}

export interface RestoredDay {
  date: string
  /** null = the day was empty. */
  workout: {
    id: string
    name: string
    notes?: string | null
    completed_at?: string | null
    created_at?: string
    mediaIds?: string[]
    exercises: RestoredExercise[]
  } | null
}

const exerciseRow = (workoutId: string, ex: RestoredExercise) => ({
  id: ex.id,
  workout_id: workoutId,
  name: ex.name,
  sets: ex.sets ?? null,
  reps: ex.reps ?? null,
  weight: ex.weight ?? null,
  duration: ex.duration ?? null,
  distance: ex.distance ?? null,
  notes: ex.notes ?? null,
  order_index: ex.order_index,
  rest_time: ex.rest_time ?? null,
  intensity: ex.intensity ?? null,
  load_used: ex.load_used ?? null,
  rpe: ex.rpe ?? null,
  reps_done: ex.reps_done ?? null,
  velocity: ex.velocity ?? null,
  group_id: ex.group_id ?? null,
  suggestion_note: ex.suggestion_note ?? null,
})

/**
 * Put the given days back as they were. Returns false if the program is gone.
 *
 * Two passes on purpose: everything on the listed dates is removed first, and
 * only then are the snapshots written. A moved day has the same id as its
 * snapshot but sits on another date, so writing as we go would collide with it.
 */
export async function restoreDays(programId: string, days: RestoredDay[]): Promise<boolean> {
  const db = getDb()
  const program = await db.selectFrom('programs').select(['id']).where('id', '=', programId).executeTakeFirst()
  if (!program) return false

  await db.transaction().execute(async (trx) => {
    for (const day of days) {
      await trx.deleteFrom('workouts')
        .where('program_id', '=', programId)
        .where('scheduled_date', '=', day.date)
        .execute()
    }
    for (const day of days) {
      const w = day.workout
      if (!w) continue
      await trx.insertInto('workouts').values({
        id: w.id,
        program_id: programId,
        name: w.name,
        scheduled_date: day.date,
        completed_at: w.completed_at ?? null,
        notes: w.notes ?? null,
        created_at: w.created_at ?? new Date().toISOString(),
      }).execute()
      for (const ex of w.exercises) {
        await trx.insertInto('exercises').values(exerciseRow(w.id, ex)).execute()
      }
      // Deleting a day detaches its Discord videos (ON DELETE SET NULL). Attach
      // the ones that were on it again — but never take one that has since been
      // attached somewhere else.
      if (w.mediaIds?.length) {
        await trx.updateTable('discord_media')
          .set({ workout_id: w.id })
          .where('id', 'in', w.mediaIds)
          .where('workout_id', 'is', null)
          .execute()
      }
    }
  })
  return true
}

/**
 * Put deleted exercises back into a day that still exists, at the positions
 * they had. Returns null if the day is gone.
 *
 * Narrower than restoreDays on purpose: undoing one deleted exercise must not
 * also roll back whatever the coach typed elsewhere on the day in the seconds
 * before they pressed Undo.
 */
export async function restoreExercises(programId: string, workoutId: string, exercises: RestoredExercise[]) {
  const db = getDb()
  const workout = await db.selectFrom('workouts').select(['id'])
    .where('id', '=', workoutId).where('program_id', '=', programId).executeTakeFirst()
  if (!workout) return null

  await db.transaction().execute(async (trx) => {
    for (const ex of exercises) {
      await trx.insertInto('exercises').values(exerciseRow(workoutId, ex)).execute()
    }
  })
  return db.selectFrom('exercises').selectAll()
    .where('workout_id', '=', workoutId)
    .orderBy('order_index')
    .orderBy('id')
    .execute()
}
