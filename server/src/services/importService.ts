import ExcelJS from 'exceljs'
import { TOGGLEABLE_COLUMNS } from 'coachboard-shared'
import type { ImportMatch, ImportWarning, ImportPreview, E1RMEstimate } from 'coachboard-shared'
import { estimate1RM } from 'coachboard-shared/rpe'
import {
  DAY_NAMES,
  buildExportColumnKeys,
  weekColumnStart,
} from 'coachboard-shared/exportLayout'
import { findProgramForExport } from './programService.js'
import { getDb } from '../db.js'

// Accept both comma and period decimal separators (Swedish Excel uses commas).
function parseCellValue(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined || value === '') return null
  const str = String(value).trim().replace(',', '.')
  return str === '' ? null : str
}

function buildEnabledSet(rawEnabledColumns: string | null): Set<string> {
  if (!rawEnabledColumns) return new Set(TOGGLEABLE_COLUMNS)
  try {
    const parsed = JSON.parse(rawEnabledColumns)
    if (Array.isArray(parsed)) return new Set(parsed.filter((c: unknown) => typeof c === 'string'))
  } catch { /* fall through */ }
  return new Set(TOGGLEABLE_COLUMNS)
}

/**
 * Parse an uploaded Excel file and match each filled tracking cell back to
 * its exercise in the database.
 *
 * The algorithm replays the exporter's layout calculation to derive exact
 * (row, column) positions for every exercise, then reads those cells from
 * the workbook. No structural parsing of the sheet is required.
 */
export async function parseImportFile(buffer: Buffer, programId: string): Promise<ImportPreview> {
  const data = await findProgramForExport(programId)
  if (!data) throw new Error('Program not found')
  const { program, workouts, exercises } = data

  if (!program.start_date || !program.end_date) {
    throw new Error('Program has no date range — cannot match import to exercises')
  }

  const enabledSet = buildEnabledSet(program.enabled_columns)
  const columnKeys = buildExportColumnKeys([...enabledSet])
  const exportColumnCount = columnKeys.length
  const getWeekColStart = (wi: number) => weekColumnStart(wi, exportColumnCount)

  const nameOffset = columnKeys.indexOf('name')       // always 0
  const loadUsedOffset = columnKeys.indexOf('load_used')
  const rpeOffset = columnKeys.indexOf('rpe')

  if (loadUsedOffset < 0 && rpeOffset < 0) {
    return {
      matched: [],
      warnings: [{
        message: 'Neither "Load Used" nor "Last Set RPE" are enabled for this program — nothing to import.',
      }],
      e1rmEstimates: [],
    }
  }

  // -------------------------------------------------------------------------
  // Rebuild the exercise layout — identical to the exporter's dayData loop
  // -------------------------------------------------------------------------
  const toIso = (d: Date) => d.toISOString().slice(0, 10)
  const mondayOf = (date: Date) => {
    const offset = date.getUTCDay() === 0 ? -6 : 1 - date.getUTCDay()
    const m = new Date(date)
    m.setUTCDate(date.getUTCDate() + offset)
    return m
  }

  const exercisesByWorkout = new Map<string, typeof exercises>()
  for (const ex of exercises) {
    const list = exercisesByWorkout.get(ex.workout_id) ?? []
    list.push(ex)
    exercisesByWorkout.set(ex.workout_id, list)
  }
  const workoutByDate = new Map<string, typeof workouts[number]>()
  for (const w of workouts) {
    if (w.scheduled_date) workoutByDate.set(w.scheduled_date, w)
  }

  const [sy, sm, sd] = program.start_date.split('-').map(Number)
  const [ey, em, ed] = program.end_date.split('-').map(Number)
  const startMonday = mondayOf(new Date(Date.UTC(sy, sm - 1, sd)))
  const endDate = new Date(Date.UTC(ey, em - 1, ed))
  const numWeeks = Math.max(
    1,
    Math.ceil((Math.round((endDate.getTime() - startMonday.getTime()) / 86400000) + 1) / 7),
  )

  type ExerciseRow = typeof exercises[number]
  type LayoutEntry = {
    exercise: ExerciseRow
    weekIndex: number
    dayOfWeek: number
    rowIndex: number
    sheetRow: number
    weekColStart: number
  }

  const layout: LayoutEntry[] = []

  // Row 1 = week headers. Row 2 = first day's header row.
  // For each day: header row, then bodyCount exercise rows, then one blank row.
  let sheetRow = 2 // points at the current day's header row

  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    const perWeek: ExerciseRow[][] = []
    let maxRows = 0
    for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
      const date = new Date(startMonday)
      date.setUTCDate(startMonday.getUTCDate() + weekIndex * 7 + dayOfWeek)
      const workout = workoutByDate.get(toIso(date))
      const exList = workout ? (exercisesByWorkout.get(workout.id) ?? []) : []
      perWeek.push(exList)
      if (exList.length > maxRows) maxRows = exList.length
    }

    sheetRow++ // advance past header row → first exercise row

    const bodyCount = Math.max(maxRows, 1)
    for (let r = 0; r < bodyCount; r++) {
      for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
        const exercise = perWeek[weekIndex][r]
        if (!exercise) continue
        layout.push({
          exercise,
          weekIndex,
          dayOfWeek,
          rowIndex: r,
          sheetRow,
          weekColStart: getWeekColStart(weekIndex),
        })
      }
      sheetRow++
    }
    sheetRow++ // blank separator between days
  }

  // -------------------------------------------------------------------------
  // Load the workbook and read tracking cells
  // -------------------------------------------------------------------------
  const wb = new ExcelJS.Workbook()
  // ExcelJS's Buffer type diverges from Node's generic Buffer<ArrayBufferLike>
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('No worksheet found in uploaded file')

  const matched: ImportMatch[] = []
  const warnings: ImportWarning[] = []

  for (const entry of layout) {
    const { exercise, weekIndex, dayOfWeek, rowIndex, sheetRow: r, weekColStart: col } = entry

    const sheetName =
      nameOffset >= 0
        ? parseCellValue(ws.getCell(r, col + nameOffset).value)
        : null

    const load_used =
      loadUsedOffset >= 0
        ? parseCellValue(ws.getCell(r, col + loadUsedOffset).value)
        : null

    const rpe =
      rpeOffset >= 0
        ? parseCellValue(ws.getCell(r, col + rpeOffset).value)
        : null

    const nameMismatch =
      sheetName !== null && sheetName.toLowerCase() !== exercise.name.toLowerCase()

    if (nameMismatch) {
      warnings.push({
        weekIndex,
        dayOfWeek,
        rowIndex,
        message:
          `Week ${weekIndex + 1} / ${DAY_NAMES[dayOfWeek]} row ${rowIndex + 1}: ` +
          `expected "${exercise.name}", found "${sheetName}" in sheet`,
      })
    }

    if (load_used !== null || rpe !== null) {
      matched.push({
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        sheetName,
        weekIndex,
        dayOfWeek,
        rowIndex,
        load_used,
        rpe,
        nameMismatch,
      })
    }
  }

  // -------------------------------------------------------------------------
  // e1RM estimates: per main-lift keyword, use the last week that lift
  // appears with data and the heaviest set (highest e1RM) in that week.
  // -------------------------------------------------------------------------
  const MAIN_LIFT_KEYWORDS = ['squat', 'bench', 'deadlift'] as const
  const exerciseMap = new Map(exercises.map((e) => [e.id, e]))

  // Group by keyword so "Squat" and "High Bar Squat" collapse into one entry.
  // Priority: later weekIndex wins; within same week, higher e1RM wins.
  const bestByKeyword = new Map<string, E1RMEstimate>()

  for (const m of matched) {
    if (!m.load_used || !m.rpe) continue

    const liftLower = m.exerciseName.toLowerCase()
    const keyword = MAIN_LIFT_KEYWORDS.find((k) => liftLower.includes(k))
    if (!keyword) continue

    const ex = exerciseMap.get(m.exerciseId)
    const repsMatch = ex?.reps?.match(/\d+/)
    if (!repsMatch) continue

    const weight = parseFloat(m.load_used)
    const rpe = parseFloat(m.rpe)
    const reps = parseInt(repsMatch[0], 10)
    if (isNaN(weight) || isNaN(rpe) || isNaN(reps)) continue

    const e1rm = estimate1RM(weight, reps, rpe)
    if (e1rm === null) continue

    const rounded = Math.round(e1rm * 10) / 10
    const candidate: E1RMEstimate = { liftName: m.exerciseName, e1rm: rounded, weight, reps, rpe, weekIndex: m.weekIndex }
    const existing = bestByKeyword.get(keyword)

    if (
      !existing ||
      m.weekIndex > existing.weekIndex ||
      (m.weekIndex === existing.weekIndex && rounded > existing.e1rm)
    ) {
      bestByKeyword.set(keyword, candidate)
    }
  }

  return { matched, warnings, e1rmEstimates: [...bestByKeyword.values()] }
}

/**
 * Commit import results to the database in a single transaction.
 * Validates that every exerciseId in `matches` belongs to `programId`.
 */
export async function commitImport(
  programId: string,
  matches: Array<Pick<ImportMatch, 'exerciseId' | 'load_used' | 'rpe'>>,
): Promise<{ updatedCount: number }> {
  const data = await findProgramForExport(programId)
  if (!data) throw new Error('Program not found')

  const validIds = new Set(data.exercises.map((e) => e.id))
  const toWrite = matches.filter((m) => validIds.has(m.exerciseId))
  if (toWrite.length === 0) return { updatedCount: 0 }

  const db = getDb()
  await db.transaction().execute(async (trx) => {
    for (const m of toWrite) {
      await trx
        .updateTable('exercises')
        .set({ load_used: m.load_used, rpe: m.rpe })
        .where('id', '=', m.exerciseId)
        .execute()
    }
    await trx
      .updateTable('programs')
      .set({ status: 'completed', updated_at: new Date().toISOString() })
      .where('id', '=', programId)
      .execute()
  })

  return { updatedCount: toWrite.length }
}
