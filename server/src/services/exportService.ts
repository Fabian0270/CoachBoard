import ExcelJS from 'exceljs'
import {
  COLUMN_LABELS,
  dayLabelFor,
  parseExportLayout,
  type ExportColumnKey,
  type ExportLayoutTemplate,
} from 'coachboard-shared/exportLayout'
import { TOGGLEABLE_COLUMNS, type ToggleableColumn } from 'coachboard-shared'
import { e1rmForExerciseName } from './exportE1RM.js'

// ---------------------------------------------------------------------------
// Program → .xlsx renderer.
//
// Two paths share one set of column getters / day data:
//   • generic   — CoachBoard's own look, driven by `enabled_columns` (the
//     behaviour the inline route exporter had before this module existed).
//   • templated — when the program carries a captured `export_layout`, the
//     coach's own colors, fonts, day labels, column wording and RPE notation
//     are replayed so the file looks like their original sheet.
//
// Geometry: `vertical` templates render the stacked-section layout; everything
// else (horizontal / block-grid / week-grid) renders the side-by-side week
// blocks — the visible differences between those three are carried by the
// descriptor (day labels, colors, RPE notation), not the geometry.
// ---------------------------------------------------------------------------

type ExerciseRow = {
  name: string
  sets: string | null
  reps: string | null
  weight: number | null
  rest_time: string | null
  intensity: string | null
  load_used: string | null
  rpe: string | null
  group_id: string | null
  order_index: number
  workout_id: string
}
type WorkoutRow = { id: string; scheduled_date: string | null }
type ProgramRow = {
  name: string
  start_date: string | null
  end_date: string | null
  enabled_columns: string | null
  export_layout: string | null
}

const DEFAULT_HEADER_COLOR = 'FFB39DDB'
const DEFAULT_TRACKING_COLOR = 'FF4DB6AC'
const DEFAULT_BANNER_COLOR = 'FFE57373'
const BORDER_COLOR = 'FFCCCCCC'

const TRACKING_KEYS = new Set<ExportColumnKey>(['load_cap', 'load_used', 'rpe'])
const COLUMN_WIDTH: Record<ExportColumnKey, number> = {
  name: 22, rest_time: 12, sets: 6, reps: 6, intensity: 16, load_cap: 10, load_used: 10, rpe: 13,
}
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const toIso = (d: Date) => d.toISOString().slice(0, 10)
function mondayOf(date: Date): Date {
  const offset = date.getUTCDay() === 0 ? -6 : 1 - date.getUTCDay()
  const m = new Date(date)
  m.setUTCDate(date.getUTCDate() + offset)
  return m
}

function formatRpe(value: string | null, notation: 'plain' | 'at'): string {
  if (value === null || value === '') return ''
  if (notation === 'at') {
    const s = String(value).trim()
    return s.startsWith('@') ? s : `@${s}`
  }
  return value
}

function getValue(ex: ExerciseRow, key: ExportColumnKey, rpeNotation: 'plain' | 'at'): string | number {
  switch (key) {
    case 'name': return ex.name ?? ''
    case 'rest_time': return ex.rest_time ?? ''
    case 'sets': return ex.sets ?? ''
    case 'reps': return ex.reps ?? ''
    case 'intensity': return ex.intensity ?? ''
    case 'load_cap': return ex.weight ?? ''
    case 'load_used': return ex.load_used ?? ''
    case 'rpe': return formatRpe(ex.rpe, rpeNotation)
  }
}

interface ResolvedColumn {
  key: ExportColumnKey
  label: string
  color: string
  width: number
}

/** Build the ordered column set + colors/labels from a template, else from enabled_columns. */
function resolveColumns(program: ProgramRow, template: ExportLayoutTemplate | null): {
  columns: ResolvedColumn[]
  colors: { banner: string; dayHeader: string; body: string | null }
  fonts: { headerBold: boolean; headerItalic: boolean; nameBold: boolean }
  rpeNotation: 'plain' | 'at'
} {
  const headerColor = template?.colors.columnHeader || DEFAULT_HEADER_COLOR
  const trackingColor = template?.colors.trackingHeader || DEFAULT_TRACKING_COLOR
  const colorFor = (key: ExportColumnKey) => (TRACKING_KEYS.has(key) ? trackingColor : headerColor)

  let columns: ResolvedColumn[]
  if (template && template.columns.length > 0) {
    columns = template.columns.map((c) => ({
      key: c.key,
      label: c.label || COLUMN_LABELS[c.key],
      color: colorFor(c.key),
      width: COLUMN_WIDTH[c.key],
    }))
  } else {
    const enabled = parseEnabledColumns(program.enabled_columns)
    const order: ExportColumnKey[] = ['name', 'rest_time', 'sets', 'reps', 'intensity', 'load_cap', 'load_used', 'rpe']
    const always = new Set<ExportColumnKey>(['name', 'sets', 'reps'])
    columns = order
      .filter((k) => always.has(k) || enabled.has(k as ToggleableColumn))
      .map((k) => ({ key: k, label: COLUMN_LABELS[k], color: colorFor(k), width: COLUMN_WIDTH[k] }))
  }

  return {
    columns,
    colors: {
      banner: template?.colors.weekBanner || DEFAULT_BANNER_COLOR,
      dayHeader: template?.colors.dayHeader || DEFAULT_BANNER_COLOR,
      body: template?.colors.body ?? null,
    },
    fonts: {
      headerBold: template ? !!template.fonts.headerBold : true,
      headerItalic: template ? !!template.fonts.headerItalic : true,
      nameBold: template ? !!template.fonts.nameBold : true,
    },
    rpeNotation: template?.rpeNotation ?? 'plain',
  }
}

function parseEnabledColumns(raw: string | null): Set<string> {
  if (!raw) return new Set(TOGGLEABLE_COLUMNS as readonly string[])
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.filter((c) => typeof c === 'string'))
  } catch { /* fall through */ }
  return new Set(TOGGLEABLE_COLUMNS as readonly string[])
}

/** Per-day exercise lists grouped by week, computed from the program calendar. */
function buildDayData(program: ProgramRow, workouts: WorkoutRow[], exercises: ExerciseRow[]) {
  const exercisesByWorkout = new Map<string, ExerciseRow[]>()
  for (const ex of exercises) {
    const list = exercisesByWorkout.get(ex.workout_id) ?? []
    list.push(ex)
    exercisesByWorkout.set(ex.workout_id, list)
  }
  const workoutByDate = new Map<string, WorkoutRow>()
  for (const w of workouts) if (w.scheduled_date) workoutByDate.set(w.scheduled_date, w)

  const [sy, sm, sd] = (program.start_date ?? '').split('-').map(Number)
  const [ey, em, ed] = (program.end_date ?? '').split('-').map(Number)
  const startMonday = mondayOf(new Date(Date.UTC(sy, sm - 1, sd)))
  const endDate = new Date(Date.UTC(ey, em - 1, ed))
  const numWeeks = Math.max(
    1,
    Math.ceil((Math.round((endDate.getTime() - startMonday.getTime()) / 86400000) + 1) / 7),
  )

  const dayData: Array<{ perWeek: ExerciseRow[][]; maxRows: number }> = []
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    const perWeek: ExerciseRow[][] = []
    let maxRows = 0
    for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
      const date = new Date(startMonday)
      date.setUTCDate(startMonday.getUTCDate() + weekIndex * 7 + dayOfWeek)
      const workout = workoutByDate.get(toIso(date))
      const exList = workout ? exercisesByWorkout.get(workout.id) ?? [] : []
      perWeek.push(exList)
      if (exList.length > maxRows) maxRows = exList.length
    }
    dayData.push({ perWeek, maxRows })
  }
  return { dayData, numWeeks }
}

export interface RenderOptions {
  /** Override the descriptor that would otherwise be parsed from program.export_layout
   *  (used to replay a built-in look like "Minimalistic" without persisting its JSON). */
  templateOverride?: ExportLayoutTemplate | null
  /** Render the "Modern" card layout with a per-lift e1RM reference badge. */
  modern?: { e1rmRef: Record<string, number> }
}

export async function renderProgramWorkbook(
  program: ProgramRow,
  workouts: WorkoutRow[],
  exercises: ExerciseRow[],
  opts: RenderOptions = {},
): Promise<Buffer> {
  const template =
    opts.templateOverride !== undefined ? opts.templateOverride : parseExportLayout(program.export_layout)
  const wb = new ExcelJS.Workbook()
  const sheetName = (program.name || 'Program').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Program'
  const ws = wb.addWorksheet(sheetName)

  const { dayData, numWeeks } = buildDayData(program, workouts, exercises)

  if (opts.modern) {
    renderModern(ws, program, dayData, numWeeks, opts.modern.e1rmRef)
  } else {
    const resolved = resolveColumns(program, template)
    const dayLabel = (dayOfWeek: number) =>
      template ? dayLabelFor(template.dayLabels, dayOfWeek) : DAY_NAMES[dayOfWeek]
    if (template && template.orientation === 'vertical') {
      renderVertical(ws, resolved, dayData, numWeeks, dayLabel)
    } else {
      renderHorizontal(ws, resolved, dayData, numWeeks, dayLabel)
    }
  }

  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer as ArrayBuffer)
}

type Resolved = ReturnType<typeof resolveColumns>

const fill = (argb: string): ExcelJS.FillPattern => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
const thinBorder: ExcelJS.Border = { style: 'thin', color: { argb: BORDER_COLOR } }
const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder }

// ---------------------------------------------------------------------------
// Horizontal — weeks side by side, days as Mon–Sun section rows (CoachBoard's
// own look and the shape of most powerlifting sheets).
// ---------------------------------------------------------------------------
function renderHorizontal(
  ws: ExcelJS.Worksheet,
  resolved: Resolved,
  dayData: Array<{ perWeek: ExerciseRow[][]; maxRows: number }>,
  numWeeks: number,
  dayLabel: (d: number) => string,
): void {
  const { columns, colors, fonts, rpeNotation } = resolved
  const fixedColumnCount = 1
  const columnCount = columns.length
  const weekColumnStart = (weekIndex: number) => fixedColumnCount + 1 + weekIndex * (columnCount + 1)
  const totalCols = fixedColumnCount + numWeeks * columnCount + (numWeeks - 1)

  ws.getColumn(1).width = 13
  for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
    const col = weekColumnStart(weekIndex)
    columns.forEach((c, i) => { ws.getColumn(col + i).width = c.width })
    if (weekIndex < numWeeks - 1) ws.getColumn(col + columnCount).width = 3
  }

  let row = 1
  for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
    const col = weekColumnStart(weekIndex)
    const cell = ws.getCell(row, col)
    cell.value = `Week ${weekIndex + 1}`
    cell.fill = fill(colors.banner)
    cell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = allBorders
    if (columnCount > 1) ws.mergeCells(row, col, row, col + columnCount - 1)
  }
  row++

  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    const { perWeek, maxRows } = dayData[dayOfWeek]

    const dayCell = ws.getCell(row, 1)
    dayCell.value = dayLabel(dayOfWeek)
    dayCell.fill = fill(colors.dayHeader)
    dayCell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
    dayCell.alignment = { horizontal: 'left', vertical: 'middle' }
    dayCell.border = allBorders
    for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
      const col = weekColumnStart(weekIndex)
      columns.forEach((c, i) => {
        const cell = ws.getCell(row, col + i)
        cell.value = c.label
        cell.fill = fill(c.color)
        cell.font = { bold: fonts.headerBold, italic: fonts.headerItalic }
        cell.alignment = { horizontal: 'left', vertical: 'middle' }
        cell.border = allBorders
      })
    }
    row++

    const bodyCount = Math.max(maxRows, 1)
    for (let r = 0; r < bodyCount; r++) {
      if (r === 0) {
        const noteCell = ws.getCell(row, 1)
        noteCell.value = 'notes:'
        noteCell.font = { italic: true, color: { argb: 'FF888888' } }
      }
      for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
        const exercise = perWeek[weekIndex][r]
        if (!exercise) continue
        const prevExercise = r > 0 ? perWeek[weekIndex][r - 1] : null
        const isSubSet = !!(prevExercise && exercise.group_id && exercise.group_id === prevExercise.group_id)
        const col = weekColumnStart(weekIndex)
        columns.forEach((c, i) => {
          const cell = ws.getCell(row, col + i)
          cell.value = isSubSet && c.key === 'name' ? '' : getValue(exercise, c.key, rpeNotation)
          if (c.key === 'name' && !isSubSet && fonts.nameBold) cell.font = { bold: true }
        })
      }
      for (let c = 1; c <= totalCols; c++) {
        const offset = c - fixedColumnCount - 1
        const isGap = c > fixedColumnCount && offset >= 0 && (offset % (columnCount + 1)) === columnCount
        if (isGap) continue
        const cell = ws.getCell(row, c)
        cell.border = allBorders
        if (colors.body) cell.fill = fill(colors.body)
        if (c >= fixedColumnCount + 1) {
          const exportCol = columns[offset % (columnCount + 1)]
          cell.alignment = { horizontal: exportCol?.key === 'name' ? 'left' : 'center', vertical: 'middle' }
        }
      }
      row++
    }
    row++
  }
}

// ---------------------------------------------------------------------------
// Vertical — one column set, weeks and days stacked top-to-bottom as section
// rows. Round-trips through the external import vertical parser.
// ---------------------------------------------------------------------------
function renderVertical(
  ws: ExcelJS.Worksheet,
  resolved: Resolved,
  dayData: Array<{ perWeek: ExerciseRow[][]; maxRows: number }>,
  numWeeks: number,
  dayLabel: (d: number) => string,
): void {
  const { columns, colors, fonts, rpeNotation } = resolved

  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width })

  // Top column-header row (single, as the vertical parser expects).
  let row = 1
  columns.forEach((c, i) => {
    const cell = ws.getCell(row, i + 1)
    cell.value = c.label
    cell.fill = fill(c.color)
    cell.font = { bold: fonts.headerBold, italic: fonts.headerItalic }
    cell.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle' }
    cell.border = allBorders
  })
  row += 2

  for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
    const weekCell = ws.getCell(row, 1)
    weekCell.value = `Week ${weekIndex + 1}`
    weekCell.fill = fill(colors.banner)
    weekCell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
    weekCell.border = allBorders
    row++

    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const exList = dayData[dayOfWeek].perWeek[weekIndex]
      if (!exList || exList.length === 0) continue // vertical sheets omit empty days

      const dayCell = ws.getCell(row, 1)
      dayCell.value = dayLabel(dayOfWeek)
      dayCell.fill = fill(colors.dayHeader)
      dayCell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
      dayCell.border = allBorders
      row++

      for (let r = 0; r < exList.length; r++) {
        const exercise = exList[r]
        const prev = r > 0 ? exList[r - 1] : null
        const isSubSet = !!(prev && exercise.group_id && exercise.group_id === prev.group_id)
        columns.forEach((c, i) => {
          const cell = ws.getCell(row, i + 1)
          cell.value = isSubSet && c.key === 'name' ? '' : getValue(exercise, c.key, rpeNotation)
          if (colors.body) cell.fill = fill(colors.body)
          if (c.key === 'name' && !isSubSet && fonts.nameBold) cell.font = { bold: true }
          cell.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle' }
          cell.border = allBorders
        })
        row++
      }
      row++ // blank separator between days
    }
  }
}

// ---------------------------------------------------------------------------
// Modern — a card-style, app-like layout. Weeks and days stack top-to-bottom;
// each exercise is a two-row "card" (a bold name row + a prescription summary
// row). Main lifts carry an inline e1RM reference badge. Empty days are omitted
// to keep the sheet tight. Built-in "Modern" template only (not an import shape).
// ---------------------------------------------------------------------------
const MODERN = {
  title: 'FF0F172A',        // slate-900
  weekBanner: 'FF4F46E5',   // indigo-600
  dayHeader: 'FFE0E7FF',    // indigo-100
  dayHeaderText: 'FF3730A3',// indigo-800
  cardName: 'FFFFFFFF',
  cardDetail: 'FFF8FAFC',   // slate-50
  badge: 'FF64748B',        // slate-500
  detailText: 'FF475569',   // slate-600
  border: 'FFE2E8F0',       // slate-200
} as const
const MODERN_WIDTH = 4

function fmtKg(value: number): string {
  return `${Math.round(value * 2) / 2}`
}

/** One-line prescription summary for a Modern card, e.g. "5 × 5   ·   100 kg   ·   RPE 8". */
function prescriptionSummary(ex: ExerciseRow): string {
  const parts: string[] = []
  const sets = (ex.sets ?? '').trim()
  const reps = (ex.reps ?? '').trim()
  if (sets && reps) parts.push(`${sets} × ${reps}`)
  else if (reps) parts.push(`${reps} reps`)
  else if (sets) parts.push(`${sets} sets`)
  const intensity = (ex.intensity ?? '').trim()
  if (intensity) parts.push(intensity)
  if (ex.weight != null) parts.push(`${ex.weight} kg`)
  const used = (ex.load_used ?? '').trim()
  if (used) parts.push(`→ ${used} kg`)
  const rpe = (ex.rpe ?? '').trim()
  if (rpe) parts.push(`RPE ${rpe.replace(/^@/, '')}`)
  const rest = (ex.rest_time ?? '').trim()
  if (rest) parts.push(`rest ${rest}`)
  return parts.join('   ·   ')
}

function renderModern(
  ws: ExcelJS.Worksheet,
  program: ProgramRow,
  dayData: Array<{ perWeek: ExerciseRow[][]; maxRows: number }>,
  numWeeks: number,
  e1rmRef: Record<string, number>,
): void {
  const border: ExcelJS.Border = { style: 'thin', color: { argb: MODERN.border } }
  ws.getColumn(1).width = 30
  for (let c = 2; c <= MODERN_WIDTH; c++) ws.getColumn(c).width = 12
  const mergeRow = (r: number) => { if (MODERN_WIDTH > 1) ws.mergeCells(r, 1, r, MODERN_WIDTH) }
  const sideBorders = (r: number, opts: { top?: boolean; bottom?: boolean }) => {
    for (let c = 1; c <= MODERN_WIDTH; c++) {
      ws.getCell(r, c).border = {
        left: c === 1 ? border : undefined,
        right: c === MODERN_WIDTH ? border : undefined,
        top: opts.top ? border : undefined,
        bottom: opts.bottom ? border : undefined,
      }
    }
  }

  let row = 1
  const title = ws.getCell(row, 1)
  title.value = program.name || 'Program'
  title.font = { bold: true, size: 16, color: { argb: MODERN.title } }
  title.alignment = { horizontal: 'left', vertical: 'middle' }
  mergeRow(row); ws.getRow(row).height = 26
  row += 2

  for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
    const wk = ws.getCell(row, 1)
    wk.value = `Week ${weekIndex + 1}`
    wk.fill = fill(MODERN.weekBanner)
    wk.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }
    wk.alignment = { horizontal: 'left', vertical: 'middle' }
    mergeRow(row); ws.getRow(row).height = 22
    row++

    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const exList = dayData[dayOfWeek].perWeek[weekIndex]
      if (!exList || exList.length === 0) continue // Modern omits empty days

      const dh = ws.getCell(row, 1)
      dh.value = DAY_NAMES[dayOfWeek]
      dh.fill = fill(MODERN.dayHeader)
      dh.font = { bold: true, color: { argb: MODERN.dayHeaderText } }
      dh.alignment = { horizontal: 'left', vertical: 'middle' }
      mergeRow(row)
      row++

      for (let r = 0; r < exList.length; r++) {
        const ex = exList[r]
        const prev = r > 0 ? exList[r - 1] : null
        const isSubSet = !!(prev && ex.group_id && ex.group_id === prev.group_id)

        // Card name row — bold name, plus an e1RM badge for main lifts.
        const nameCell = ws.getCell(row, 1)
        const e1 = isSubSet ? null : e1rmForExerciseName(ex.name, e1rmRef)
        if (isSubSet) {
          nameCell.value = ''
        } else if (e1 != null) {
          nameCell.value = {
            richText: [
              { text: ex.name, font: { bold: true, size: 12, color: { argb: MODERN.title } } },
              { text: `      e1RM ${fmtKg(e1)} kg`, font: { size: 10, color: { argb: MODERN.badge } } },
            ],
          }
        } else {
          nameCell.value = ex.name
          nameCell.font = { bold: true, size: 12, color: { argb: MODERN.title } }
        }
        nameCell.fill = fill(MODERN.cardName)
        nameCell.alignment = { horizontal: 'left', vertical: 'middle' }
        mergeRow(row)
        sideBorders(row, { top: true })
        row++

        // Card detail row — prescription summary.
        const detail = ws.getCell(row, 1)
        detail.value = prescriptionSummary(ex)
        detail.fill = fill(MODERN.cardDetail)
        detail.font = { color: { argb: MODERN.detailText } }
        detail.alignment = { horizontal: 'left', vertical: 'middle' }
        mergeRow(row)
        sideBorders(row, { bottom: true })
        row++
      }
      row++ // spacer after each day
    }
    row++ // spacer after each week
  }
}
