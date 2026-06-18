import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'

// ---------------------------------------------------------------------------
// Column helpers — live here because they touch DB representation
// ---------------------------------------------------------------------------

const TOGGLEABLE_COLUMNS = ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'] as const
type ToggleableColumn = typeof TOGGLEABLE_COLUMNS[number]

export function serializeEnabledColumns(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (!Array.isArray(input)) return null
  const filtered = input.filter(
    (c): c is ToggleableColumn =>
      typeof c === 'string' && (TOGGLEABLE_COLUMNS as readonly string[]).includes(c),
  )
  return JSON.stringify(filtered)
}

export function withParsedColumns<T extends { enabled_columns: string | null }>(
  program: T,
): T & { enabled_columns: ToggleableColumn[] | null } {
  if (!program.enabled_columns) return { ...program, enabled_columns: null }
  try {
    const parsed = JSON.parse(program.enabled_columns)
    if (!Array.isArray(parsed)) return { ...program, enabled_columns: null }
    return {
      ...program,
      enabled_columns: parsed.filter((c): c is ToggleableColumn =>
        (TOGGLEABLE_COLUMNS as readonly string[]).includes(c),
      ),
    }
  } catch {
    return { ...program, enabled_columns: null }
  }
}

const toIso = (d: Date) => d.toISOString().slice(0, 10)

function mondayOf(date: Date): Date {
  const dayOfWeek = date.getUTCDay()
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = new Date(date)
  monday.setUTCDate(date.getUTCDate() + offset)
  return monday
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

export async function findAllPrograms(athleteId?: string) {
  let query = getDb().selectFrom('programs').selectAll()
  if (athleteId) query = query.where('athlete_id', '=', athleteId)
  const rows = await query.orderBy('created_at', 'desc').execute()
  return rows.map(withParsedColumns)
}

export async function findProgramById(id: string) {
  const program = await getDb()
    .selectFrom('programs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!program) return undefined

  const workouts = await getDb()
    .selectFrom('workouts')
    .selectAll()
    .where('program_id', '=', id)
    .orderBy('scheduled_date')
    .execute()

  const workoutIds = workouts.map((w) => w.id)
  const exercises = workoutIds.length
    ? await getDb()
        .selectFrom('exercises')
        .selectAll()
        .where('workout_id', 'in', workoutIds)
        .orderBy('order_index')
        .execute()
    : []

  return {
    ...withParsedColumns(program),
    workouts: workouts.map((w) => ({
      ...w,
      exercises: exercises.filter((e) => e.workout_id === w.id),
    })),
  }
}

export async function findProgramForExport(id: string) {
  const program = await getDb()
    .selectFrom('programs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!program) return undefined

  const workouts = await getDb()
    .selectFrom('workouts')
    .selectAll()
    .where('program_id', '=', program.id)
    .execute()

  const workoutIds = workouts.map((w) => w.id)
  const exercises = workoutIds.length
    ? await getDb()
        .selectFrom('exercises')
        .selectAll()
        .where('workout_id', 'in', workoutIds)
        .orderBy('order_index')
        .execute()
    : []

  return { program, workouts, exercises }
}

export async function createProgram(data: {
  athlete_id: string
  name: string
  description?: string | null
  start_date?: string | null
  end_date?: string | null
  status?: string
  enabled_columns?: unknown
  focus?: string | null
}) {
  const now = new Date().toISOString()
  const row = await getDb()
    .insertInto('programs')
    .values({
      id: uuidv4(),
      athlete_id: data.athlete_id,
      name: data.name,
      description: data.description ?? null,
      start_date: data.start_date ?? null,
      end_date: data.end_date ?? null,
      status: data.status ?? 'active',
      enabled_columns: serializeEnabledColumns(data.enabled_columns),
      focus: data.focus ?? null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return withParsedColumns(row)
}

export async function updateProgram(
  id: string,
  data: {
    name?: string
    description?: string | null
    start_date?: string | null
    end_date?: string | null
    status?: string
    enabled_columns?: unknown
    focus?: string | null
  },
) {
  const row = await getDb()
    .updateTable('programs')
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description ?? null } : {}),
      ...(data.start_date !== undefined ? { start_date: data.start_date ?? null } : {}),
      ...(data.end_date !== undefined ? { end_date: data.end_date ?? null } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.enabled_columns !== undefined
        ? { enabled_columns: serializeEnabledColumns(data.enabled_columns) }
        : {}),
      ...(data.focus !== undefined ? { focus: data.focus ?? null } : {}),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
  return row ? withParsedColumns(row) : undefined
}

export async function deleteProgram(id: string) {
  return getDb().deleteFrom('programs').where('id', '=', id).returningAll().executeTakeFirst()
}

export async function setProgramDuration(id: string, startDate: string, weeks: number) {
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const monday = mondayOf(new Date(Date.UTC(sy, sm - 1, sd)))
  const end = new Date(monday)
  end.setUTCDate(monday.getUTCDate() + weeks * 7 - 1)

  const row = await getDb()
    .updateTable('programs')
    .set({
      start_date: toIso(monday),
      end_date: toIso(end),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
  return row ? withParsedColumns(row) : undefined
}

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
