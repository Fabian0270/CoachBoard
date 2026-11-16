import { v4 as uuidv4 } from 'uuid'
import { sql } from 'kysely'
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
  restoreDays,
  restoreExercises,
  renameExerciseInProgram,
} from './program/workoutService.js'
export {
  createExercise,
  updateExercise,
  deleteExercise,
  reorderExercises,
  addSetToExercise,
  duplicateExercise,
  findExerciseNames,
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

/**
 * Every program, with a flag for whether it has an imported Excel workbook.
 * The workbook itself lives in template_blobs (see templateBlobStore).
 */
export async function findAllPrograms(athleteId?: string) {
  let query = getDb()
    .selectFrom('programs')
    .select([
      'id', 'athlete_id', 'name', 'description', 'start_date', 'end_date', 'status',
      'created_at', 'updated_at', 'enabled_columns', 'focus', 'export_layout',
      'builtin_template', 'bookmarked',
    ])
    .select(sql<number>`export_template_sha IS NOT NULL`.as('has_export_template'))
  if (athleteId) query = query.where('athlete_id', '=', athleteId)
  const rows = await query.orderBy('created_at', 'desc').execute()
  return rows.map((r) => ({ ...withParsedColumns(r), has_export_template: r.has_export_template === 1 }))
}

/**
 * A program as it goes over HTTP: the workbook's storage key replaced by a
 * flag. The key is an internal detail; the client only ever needs to know
 * whether the program exports in an imported style.
 */
export function withoutTemplateBlob<T extends { export_template_sha?: string | null }>(
  program: T,
): Omit<T, 'export_template_sha'> & { has_export_template: boolean } {
  const { export_template_sha, ...rest } = program
  return { ...rest, has_export_template: !!export_template_sha }
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
  /** null = no athlete: a template. */
  athlete_id: string | null
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
  // The workbook is shared by key, not copied — that copying is what used to
  // multiply one import into tens of megabytes.
  let exportTemplateSha: string | null = null
  let enabledColumns = serializeEnabledColumns(data.enabled_columns)
  if (data.export_style_id) {
    const style = await getDb()
      .selectFrom('export_styles')
      .select(['descriptor', 'template_sha'])
      .where('id', '=', data.export_style_id)
      .executeTakeFirst()
    if (style) {
      exportLayout = style.descriptor
      exportTemplateSha = style.template_sha
    }
  } else if (data.style_source_program_id) {
    const source = await getDb()
      .selectFrom('programs')
      .select(['export_layout', 'export_template_sha', 'enabled_columns'])
      .where('id', '=', data.style_source_program_id)
      .executeTakeFirst()
    if (source) {
      exportLayout = source.export_layout
      exportTemplateSha = source.export_template_sha
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
      export_template_sha: exportTemplateSha,
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
    bookmarked?: boolean
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
      ...(data.bookmarked !== undefined ? { bookmarked: data.bookmarked ? 1 : 0 } : {}),
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

const parseIso = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/**
 * Thrown when a new duration would leave training days outside the program and
 * the caller has not said they may be removed. Carries what would be lost, so
 * the question put to the coach can be specific.
 */
export class DurationWouldRemoveDays extends Error {
  constructor(readonly days: number, readonly daysWithResults: number) {
    super(`This would remove ${days} training day${days === 1 ? '' : 's'} that fall outside the new dates`)
    this.name = 'DurationWouldRemoveDays'
  }
}

/**
 * Set where a program starts and how many weeks it runs.
 *
 * The training days travel with the start date. This used to change only the
 * program's two dates: postponing a block by a week left every training day on
 * its old date, so week 1 showed empty and the last week's days dropped off the
 * end of the calendar — still stored, never shown.
 *
 * Days that end up outside the new dates (shortening the program) are removed,
 * but only when `removeOutside` says so; otherwise nothing is changed and
 * DurationWouldRemoveDays reports what is at stake.
 */
export async function setProgramDuration(id: string, startDate: string, weeks: number, removeOutside = false) {
  const monday = mondayOf(parseIso(startDate))
  const end = new Date(monday)
  end.setUTCDate(monday.getUTCDate() + weeks * 7 - 1)
  const newStart = toIso(monday)
  const newEnd = toIso(end)

  return getDb().transaction().execute(async (trx) => {
    const program = await trx.selectFrom('programs').select(['id', 'start_date']).where('id', '=', id).executeTakeFirst()
    if (!program) return undefined

    // Whole days between the old first Monday and the new one. A program that
    // had no dates yet has nothing to move.
    const shiftDays = program.start_date
      ? Math.round((monday.getTime() - mondayOf(parseIso(program.start_date)).getTime()) / 86_400_000)
      : 0

    const workouts = await trx
      .selectFrom('workouts')
      .select(['id', 'name', 'scheduled_date'])
      .where('program_id', '=', id)
      .execute()
    const planned = workouts
      .filter((w): w is typeof w & { scheduled_date: string } => !!w.scheduled_date)
      .map((w) => {
        const moved = parseIso(w.scheduled_date)
        moved.setUTCDate(moved.getUTCDate() + shiftDays)
        return { ...w, newDate: toIso(moved) }
      })

    const outside = planned.filter((w) => w.newDate < newStart || w.newDate > newEnd)
    if (outside.length > 0) {
      if (!removeOutside) {
        const logged = await trx
          .selectFrom('exercises')
          .select('workout_id')
          .distinct()
          .where('workout_id', 'in', outside.map((w) => w.id))
          .where((eb) => eb.or([
            eb.and([eb('load_used', 'is not', null), eb(sql`TRIM(load_used)`, '<>', '')]),
            eb.and([eb('rpe', 'is not', null), eb(sql`TRIM(rpe)`, '<>', '')]),
          ]))
          .execute()
        throw new DurationWouldRemoveDays(outside.length, logged.length)
      }
      await trx.deleteFrom('workouts').where('id', 'in', outside.map((w) => w.id)).execute()
    }

    if (shiftDays !== 0) {
      const gone = new Set(outside.map((w) => w.id))
      for (const w of planned) {
        if (gone.has(w.id)) continue
        await trx
          .updateTable('workouts')
          // A day is named after its date unless the coach named it.
          .set({ scheduled_date: w.newDate, name: w.name === w.scheduled_date ? w.newDate : w.name })
          .where('id', '=', w.id)
          .execute()
      }
    }

    const row = await trx
      .updateTable('programs')
      .set({ start_date: newStart, end_date: newEnd, updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    return row ? withParsedColumns(row) : undefined
  })
}
