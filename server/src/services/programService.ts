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
