import ExcelJS from 'exceljs'
import { TOGGLEABLE_COLUMNS } from 'coachboard-shared'
import type { ImportMatch, ImportWarning, ImportPreview, E1RMEstimate } from 'coachboard-shared'
import { estimate1RM } from 'coachboard-shared/rpe'
import {
  DAY_NAMES,
  resolveExportRenderPath,
  weekColumnStart,
} from 'coachboard-shared/exportLayout'
import { findProgramForExport } from './programService.js'
import {
  cellText,
  findResultsBlocks,
  nameColForWeek,
  type ResultsBlock,
} from './resultsSheetLayout.js'
import { getDb } from '../db.js'

// Accept both comma and period decimal separators (Swedish Excel uses commas).
function parseCellValue(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined || value === '') return null
  const str = String(value).trim().replace(',', '.')
  return str === '' ? null : str
}

/** One exercise's three cells, however they were located in the sheet. */
interface CellRead {
  exercise: { id: string; name: string }
  weekIndex: number
  dayOfWeek: number
  rowIndex: number
  sheetName: string | null
  load_used: string | null
  rpe: string | null
}

const textOrNull = (ws: ExcelJS.Worksheet, r: number, c: number): string | null => {
  const t = cellText(ws, r, c).trim()
  return t === '' ? null : t
}
const numberOrNull = (ws: ExcelJS.Worksheet, r: number, c: number): string | null => {
  const t = cellText(ws, r, c).trim().replace(',', '.')
  return t === '' ? null : t
}

/**
 * Read using the sheet's own headers: each block knows which column holds a
 * given week's Load Used, so no column count or stride is assumed anywhere.
 */
function readStructurally(
  ws: ExcelJS.Worksheet,
  blocks: ResultsBlock[],
  dayPlans: Array<Array<Array<{ id: string; name: string }>>>,
): CellRead[] {
  const reads: CellRead[] = []
  for (const block of blocks) {
    const perWeek = dayPlans[block.dayOfWeek]
    if (!perWeek) continue
    const weekCount = Math.max(block.loadCols.length, block.rpeCols.length)

    for (const [rowIndex, sheetRow] of block.bodyRows.entries()) {
      for (let weekIndex = 0; weekIndex < weekCount; weekIndex++) {
        const exercise = perWeek[weekIndex]?.[rowIndex]
        if (!exercise) continue
        const nameCol = nameColForWeek(block, weekIndex)
        const loadCol = block.loadCols[weekIndex]
        const rpeCol = block.rpeCols[weekIndex]
        reads.push({
          exercise,
          weekIndex,
          dayOfWeek: block.dayOfWeek,
          rowIndex,
          sheetName: nameCol ? textOrNull(ws, sheetRow, nameCol) : null,
          load_used: loadCol ? numberOrNull(ws, sheetRow, loadCol) : null,
          rpe: rpeCol ? numberOrNull(ws, sheetRow, rpeCol) : null,
        })
      }
    }
  }
  return reads
}

/** Fallback: replay the exporter's offsets, for a sheet with no headers to read. */
function readByGeometry(
  ws: ExcelJS.Worksheet,
  layout: Array<{
    exercise: { id: string; name: string }
    weekIndex: number
    dayOfWeek: number
    rowIndex: number
    sheetRow: number
    weekColStart: number
  }>,
  offsets: { nameOffset: number; loadUsedOffset: number; rpeOffset: number },
): CellRead[] {
  const { nameOffset, loadUsedOffset, rpeOffset } = offsets
  return layout.map((entry) => {
    const { sheetRow: r, weekColStart: col } = entry
    return {
      exercise: entry.exercise,
      weekIndex: entry.weekIndex,
      dayOfWeek: entry.dayOfWeek,
      rowIndex: entry.rowIndex,
      sheetName: nameOffset >= 0 ? parseCellValue(ws.getCell(r, col + nameOffset).value) : null,
      load_used: loadUsedOffset >= 0 ? parseCellValue(ws.getCell(r, col + loadUsedOffset).value) : null,
      rpe: rpeOffset >= 0 ? parseCellValue(ws.getCell(r, col + rpeOffset).value) : null,
    }
  })
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

  // Which shape did THIS program export as? A captured coach style or a built-in
  // descriptor replaces the enabled-columns set outright, and the column count
  // feeds weekColumnStart — so reading it off enabled_columns alone silently
  // misaligns every week after the first by a growing offset.
  const enabledSet = buildEnabledSet(program.enabled_columns)
  const renderPath = resolveExportRenderPath(program, [...enabledSet])

  // Only meaningful for the geometry fallback below — a structural read derives
  // all of this from the sheet's own headers instead.
  const columnKeys = renderPath.kind === 'grid' ? renderPath.columnKeys : []
  const getWeekColStart = (wi: number) => weekColumnStart(wi, columnKeys.length)
  const nameOffset = columnKeys.indexOf('name')       // always 0
  const loadUsedOffset = columnKeys.indexOf('load_used')
  const rpeOffset = columnKeys.indexOf('rpe')
  const geometryReadable =
    renderPath.kind === 'grid' &&
    renderPath.orientation === 'horizontal' &&
    (loadUsedOffset >= 0 || rpeOffset >= 0)

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
  // [dayOfWeek][weekIndex][rowIndex] — what the program says each cell holds.
  // The structural reader matches against this by (day, week, row) too; only the
  // way the sheet coordinates are found differs.
  const dayPlans: ExerciseRow[][][] = []

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
    dayPlans.push(perWeek)

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
  let namedRowCount = 0   // rows where the sheet had an exercise name at all
  let mismatchCount = 0   // …of those, how many disagreed with the program

  // Prefer reading the sheet's own headers. A coach's captured style can share
  // one exercise-name column across every week, start below a title block, or
  // word its headers differently — none of which the offset replay can follow.
  // The replay stays as the fallback for a sheet with no headers to read.
  const blocks = findResultsBlocks(ws)

  if (blocks.length === 0 && !geometryReadable) {
    // Nothing in the program to import into — a configuration note, not a bad file.
    if (renderPath.kind === 'grid' && renderPath.orientation === 'horizontal') {
      return {
        matched: [],
        warnings: [{
          message: 'Neither "Load Used" nor "Last Set RPE" are enabled for this program — nothing to import.',
        }],
        e1rmEstimates: [],
        errors: [],
      }
    }

    const reason =
      renderPath.kind === 'opaque'
        ? `No "Load Used" or "Last Set RPE" columns were found in this sheet, and this program ` +
          `exports through ${renderPath.label}, whose layout can't be reconstructed from the ` +
          `program alone. Check you picked the filled-in file the athlete returned.`
        : renderPath.orientation === 'vertical'
          ? `This program's export style stacks weeks vertically, and this sheet has no per-week ` +
            `result columns to read. Use "Import programs" on the Programs page for this file instead.`
          : `No "Load Used" or "Last Set RPE" columns were found in this sheet. Check that you picked ` +
            `the filled-in file the athlete returned — the one with those columns filled in.`

    return { matched: [], warnings: [], e1rmEstimates: [], errors: [reason] }
  }

  const reads: CellRead[] =
    blocks.length > 0
      ? readStructurally(ws, blocks, dayPlans)
      : readByGeometry(ws, layout, { nameOffset, loadUsedOffset, rpeOffset })

  for (const { exercise, weekIndex, dayOfWeek, rowIndex, sheetName, load_used, rpe } of reads) {
    const nameMismatch =
      sheetName !== null && sheetName.toLowerCase() !== exercise.name.toLowerCase()

    if (sheetName !== null) namedRowCount++
    if (nameMismatch) mismatchCount++

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
  // Alignment gate. A name mismatch on one row is a coach renaming a lift in the
  // sheet; a name mismatch on most rows means the cells being read are not the
  // cells that were written, and every load/RPE below is junk. Refuse the file
  // rather than let it be committed — that write sets load_used/rpe on every
  // matched exercise and flips the program to completed.
  // -------------------------------------------------------------------------
  if (namedRowCount >= 3 && mismatchCount > namedRowCount / 2) {
    return {
      matched: [],
      warnings,
      e1rmEstimates: [],
      errors: [
        `The sheet doesn't line up with this program: ${mismatchCount} of ${namedRowCount} ` +
        `rows held a different exercise than expected, so nothing was imported. This usually ` +
        `means the file came from a different program, or rows were inserted or deleted — ` +
        `re-export this program and fill in that copy.`,
      ],
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

  return { matched, warnings, e1rmEstimates: [...bestByKeyword.values()], errors: [] }
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
