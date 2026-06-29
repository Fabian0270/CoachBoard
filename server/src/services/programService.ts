import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { serializeEnabledColumns, withParsedColumns } from './program/columns.js'

// Re-export the column helpers + workout/exercise services so existing
// consumers can keep importing everything from './programService.js'.
export { serializeEnabledColumns, withParsedColumns } from './program/columns.js'
export {
  createWorkout,
  updateWorkout,
  deleteWorkout,
  copyWorkoutDay,
  moveWorkoutDay,
} from './program/workoutService.js'
export {
  createExercise,
  updateExercise,
  deleteExercise,
  reorderExercises,
  addSetToExercise,
} from './program/exerciseService.js'

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
  // Copy the export_layout (and, when the caller didn't set its own, the
  // enabled_columns) from an existing program — the manual "reuse a saved style"
  // path. Silently ignored if the source program no longer exists.
  style_source_program_id?: string | null
  // Apply a saved style from the export-style library. Takes precedence over
  // style_source_program_id. Silently ignored if the style no longer exists.
  export_style_id?: string | null
  // Built-in starter look ('coachboard' | 'minimal' | 'modern') for programs that
  // don't reuse an imported coach style. Defaults to the classic CoachBoard look.
  builtin_template?: string | null
}) {
  const now = new Date().toISOString()

  let exportLayout: string | null = null
  let exportTemplateXlsx: string | null = null
  let enabledColumns = serializeEnabledColumns(data.enabled_columns)
  if (data.export_style_id) {
    const style = await getDb()
      .selectFrom('export_styles')
      .select(['descriptor', 'template_xlsx'])
      .where('id', '=', data.export_style_id)
      .executeTakeFirst()
    if (style) {
      exportLayout = style.descriptor
      exportTemplateXlsx = style.template_xlsx
    }
  } else if (data.style_source_program_id) {
    const source = await getDb()
      .selectFrom('programs')
      .select(['export_layout', 'export_template_xlsx', 'enabled_columns'])
      .where('id', '=', data.style_source_program_id)
      .executeTakeFirst()
    if (source) {
      exportLayout = source.export_layout
      exportTemplateXlsx = source.export_template_xlsx
      if (data.enabled_columns === undefined) enabledColumns = source.enabled_columns
    }
  }

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
      enabled_columns: enabledColumns,
      focus: data.focus ?? null,
      export_layout: exportLayout,
      export_template_xlsx: exportTemplateXlsx,
      builtin_template: data.builtin_template ?? 'coachboard',
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
    athlete_id?: string
    builtin_template?: string
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
      ...(data.athlete_id !== undefined ? { athlete_id: data.athlete_id } : {}),
      ...(data.builtin_template !== undefined ? { builtin_template: data.builtin_template } : {}),
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
