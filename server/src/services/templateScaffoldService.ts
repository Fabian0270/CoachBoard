import ExcelJS from 'exceljs'
import { parseExternalFile } from './externalImportService.js'
import { weekdayOffset } from './external-import/valueNormalizers.js'
import type { ExternalExerciseRow } from 'coachboard-shared'

// ---------------------------------------------------------------------------
// Scaffold export (Feature: export style templates v2) — LAYOUT-AGNOSTIC.
//
// A saved style is the coach's real .xlsx. To export a program "in that style"
// we CLONE the file (so chrome, the form-link button, merged boxes, fonts,
// borders and exact layout are preserved byte-for-byte) and then, driven purely
// by the cell positions the parser already extracts for ANY layout:
//   • add or remove whole WEEK-BLOCKS so the sheet has exactly the new program's
//     week count (a 1-week program from a 4-week style ⇒ one week);
//   • rewrite the movement names + numbers from the NEW program and clear the
//     rest, so nothing from the source program remains.
//
// Nothing is hardcoded per layout: weeks-as-columns sheets (block-grid /
// week-grid / horizontal) are all handled through one column-axis code path
// derived from each row's detected data-cell columns. Row-axis (vertical) sheets
// return null and the caller falls back to the descriptor renderer.
// ---------------------------------------------------------------------------

type ExerciseRow = {
  name: string
  sets: string | null
  reps: string | null
  weight: number | null
  intensity: string | null
  load_used: string | null
  rest_time: string | null
  rpe: string | null
  group_id: string | null
  order_index: number
  workout_id: string
}
type WorkoutRow = { id: string; scheduled_date: string | null }
type ProgramRow = { start_date: string | null }

const WEEK_BANNER = /^week\s*\d+$/i
// English + Swedish weekday day-section labels (incl. ASCII-stripped forms).
const WEEKDAY = /^(mon|tue|wed|thu|fri|sat|sun|mån|man|tis|ons|tor|fre|lör|lor|sön|son)/i
const DAY_N = /^day\s*\d+/i

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}
function mondayIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
  return date.toISOString().slice(0, 10)
}
function loadValue(ex: ExerciseRow): number | string | null {
  if (ex.weight !== null && ex.weight !== undefined) return ex.weight
  return usedLoad(ex)
}
/** The athlete's actual "Load Used" value (string load_used → number when numeric). */
function usedLoad(ex: ExerciseRow): number | string | null {
  if (!ex.load_used) return null
  const n = parseFloat(ex.load_used.replace(',', '.'))
  return isNaN(n) ? ex.load_used : n
}
/** True when this exercise is a further set of the same grouped movement as the
 *  previous one in the day — its name cell is left blank so multi-set movements
 *  read once, matching the coach's sheet and the generic renderer. */
function isSubSetOf(ex: ExerciseRow | null, prev: ExerciseRow | null): boolean {
  return !!(ex && prev && ex.group_id && ex.group_id === prev.group_id)
}
/** Movement names are never bold: the template bolds some rows (e.g. a day's first
 *  lift) but not the multi-set/spacer rows, so refilling positionally would bold
 *  some movements and not others. Clear bold while keeping the rest of the font. */
function clearBold(cell: ExcelJS.Cell): void {
  if (cell.font?.bold) cell.font = { ...cell.font, bold: false }
}
function rpeValue(ex: ExerciseRow): string | null {
  if (ex.rpe !== null && ex.rpe !== '') return String(ex.rpe)
  if (ex.intensity && /rpe|^@/i.test(ex.intensity.trim())) {
    const m = ex.intensity.match(/(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)/)
    if (m) return m[1].replace(/\s+/g, '')
  }
  return null
}

/** A1 column letters → 1-based column number. */
function colNum(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/**
 * Convert every shared-formula cell into a standalone formula carrying its own
 * (already-translated) A1 expression + cached result. Coach sheets commonly use
 * shared formulas (e1RM columns etc.); once we insert/duplicate/copy rows below,
 * the shared master can end up below/right of a clone, and ExcelJS then throws
 * "Shared Formula master must exist…" on write — which silently drops the whole
 * styled export to the generic fallback (losing the coach's form link, merges
 * and per-movement layout). De-sharing up front keeps the live formulas while
 * removing the fragile master/slave links. Must run before any row/column edits.
 */
function detachSharedFormulas(ws: ExcelJS.Worksheet): void {
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.type !== ExcelJS.ValueType.Formula) return
      const formula = cell.formula
      if (!formula) return
      cell.value = { formula, result: cell.result as ExcelJS.CellFormulaValue['result'] }
    })
  })
}

/**
 * Rebuild columns 1..lastCol of a sheet into a fresh worksheet, preserving cell
 * values, styles, hyperlinks, merges, widths and row heights. Used to drop
 * trailing week-blocks reliably (unlike spliceColumns, which drops hyperlinks).
 * Formulas are blanked — a re-filled block starts fresh and a copied shared
 * formula would have no master.
 */
function copyColumnPrefix(src: ExcelJS.Worksheet, lastCol: number, maxRow: number): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook()
  const dst = wb.addWorksheet(src.name)
  for (let c = 1; c <= lastCol; c++) {
    const w = src.getColumn(c).width
    if (w) dst.getColumn(c).width = w
  }
  for (let r = 1; r <= maxRow; r++) {
    const sr = src.getRow(r)
    if (sr.height) dst.getRow(r).height = sr.height
    for (let c = 1; c <= lastCol; c++) {
      const sc = src.getCell(r, c)
      const dc = dst.getCell(r, c)
      dc.style = sc.style
      if (sc.type === ExcelJS.ValueType.Formula) dc.value = null
      else if (sc.hyperlink) dc.value = { text: String(sc.text ?? ''), hyperlink: sc.hyperlink }
      else dc.value = sc.value
    }
  }
  const merges: string[] = (src.model?.merges as string[] | undefined)
    ?? Object.keys((src as unknown as { _merges?: Record<string, unknown> })._merges ?? {})
  for (const range of merges) {
    const m = range.match(/^[A-Z]+\d+:([A-Z]+)(\d+)$/)
    if (m && colNum(m[1]) <= lastCol && Number(m[2]) <= maxRow) {
      try { dst.mergeCells(range) } catch { /* ignore overlaps */ }
    }
  }
  return dst
}

/** Rebuild rows 1..lastRow of a sheet into a fresh worksheet (row analogue of
 *  copyColumnPrefix) — used to drop trailing week-blocks in vertical layouts. */
function copyRowPrefix(src: ExcelJS.Worksheet, lastRow: number, lastCol: number): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook()
  const dst = wb.addWorksheet(src.name)
  for (let c = 1; c <= lastCol; c++) {
    const w = src.getColumn(c).width
    if (w) dst.getColumn(c).width = w
  }
  for (let r = 1; r <= lastRow; r++) {
    const sr = src.getRow(r)
    if (sr.height) dst.getRow(r).height = sr.height
    for (let c = 1; c <= lastCol; c++) {
      const sc = src.getCell(r, c)
      const dc = dst.getCell(r, c)
      dc.style = sc.style
      if (sc.type === ExcelJS.ValueType.Formula) dc.value = null
      else if (sc.hyperlink) dc.value = { text: String(sc.text ?? ''), hyperlink: sc.hyperlink }
      else dc.value = sc.value
    }
  }
  const merges: string[] = (src.model?.merges as string[] | undefined)
    ?? Object.keys((src as unknown as { _merges?: Record<string, unknown> })._merges ?? {})
  for (const range of merges) {
    const m = range.match(/^[A-Z]+\d+:([A-Z]+)(\d+)$/)
    if (m && colNum(m[1]) <= lastCol && Number(m[2]) <= lastRow) {
      try { dst.mergeCells(range) } catch { /* ignore */ }
    }
  }
  return dst
}

interface RelCols { name: number | null; sets: number | null; reps: number | null; load: number | null; loadCap: number | null; intensity: number | null; restTime: number | null; rpe: number | null; erpe: number | null }

// ---------------------------------------------------------------------------
// Row axis (vertical layout): weeks stacked top-to-bottom, sharing columns.
// ---------------------------------------------------------------------------
interface RowSlot { relRow: number; cols: RelCols } // cols are ABSOLUTE (constant across weeks)
interface RowDay { dayIndex: number; slots: RowSlot[] }
interface RowGeometry {
  templateWeeks: number
  top: number          // first "Week n" banner row
  rowStride: number    // rows between consecutive weeks
  days: RowDay[]
  lastRow: number
}

function deriveRowGeometry(tEx: ExternalExerciseRow[], ws: ExcelJS.Worksheet): RowGeometry | null {
  const weeks = [...new Set(tEx.map((e) => e.weekIndex))].sort((a, b) => a - b)
  if (weeks.length === 0) return null
  const rowOf = (w: number) => {
    const rows = tEx.filter((e) => e.weekIndex === w).map((e) => e.sheetRow)
    return rows.length ? Math.min(...rows) : Infinity
  }
  if (weeks.length >= 2 && !(rowOf(weeks[1]) > rowOf(weeks[0]))) return null // must advance by row

  const maxRow = ws.rowCount || 0
  const maxCol = ws.columnCount || 1
  const bannerRows: number[] = []
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= maxCol; c++) {
      const v = ws.getCell(r, c).value
      if (typeof v === 'string' && WEEK_BANNER.test(v)) { bannerRows.push(r); break }
    }
  }
  if (bannerRows.length < weeks.length) return null

  const top = bannerRows[0]
  const lastRow = Math.max(...tEx.map((e) => e.sheetRow))
  const rowStride = weeks.length >= 2 ? bannerRows[1] - bannerRows[0] : lastRow - top + 2

  const week0 = tEx.filter((e) => e.weekIndex === weeks[0]).sort((a, b) => a.sheetRow - b.sheetRow)
  const days: RowDay[] = []
  for (const e of week0) {
    const c = e.refillCols!
    const slot: RowSlot = { relRow: e.sheetRow - top, cols: { name: c.name, sets: c.sets, reps: c.reps, load: c.load, loadCap: c.loadCap ?? null, intensity: c.intensity ?? null, restTime: c.restTime ?? null, rpe: c.rpe, erpe: c.erpe } }
    let d = days.find((x) => x.dayIndex === e.dayIndex)
    if (!d) { d = { dayIndex: e.dayIndex, slots: [] }; days.push(d) }
    d.slots.push(slot)
  }
  if (days.length === 0) return null
  return { templateWeeks: weeks.length, top, rowStride, days, lastRow }
}

async function renderRowAxis(
  buffer: Buffer,
  tEx: ExternalExerciseRow[],
  prog: { weekCount: number; byWeekday: Array<Map<number, ExerciseRow[]>>; seqWeekdays: number[] },
): Promise<Buffer | null> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  let ws = wb.worksheets[0]
  if (!ws) return null
  detachSharedFormulas(ws)

  const geom = deriveRowGeometry(tEx, ws)
  if (!geom) return null
  const { top, rowStride, templateWeeks } = geom
  const newWeeks = prog.weekCount
  const maxCol = ws.columnCount || 1

  // Fit the week count by stacking/removing week row-blocks.
  if (newWeeks < templateWeeks) {
    ws = copyRowPrefix(ws, top + newWeeks * rowStride - 1, maxCol)
  } else if (newWeeks > templateWeeks) {
    for (let w = templateWeeks; w < newWeeks; w++) {
      const destTop = top + w * rowStride
      for (let off = 0; off < rowStride; off++) {
        const sr = ws.getRow(top + off)
        const dr = ws.getRow(destTop + off)
        if (sr.height) dr.height = sr.height
        for (let c = 1; c <= maxCol; c++) {
          const sc = ws.getCell(top + off, c)
          const dc = ws.getCell(destTop + off, c)
          dc.style = sc.style
          dc.value = sc.type === ExcelJS.ValueType.Formula ? null : sc.value
        }
      }
    }
  }

  const rpeSlot = geom.days.flatMap((d) => d.slots).find((s) => s.cols.rpe !== null)
  const rpeAt = rpeSlot
    ? String(ws.getCell(top + rpeSlot.relRow, rpeSlot.cols.rpe!).text ?? '').trim().startsWith('@')
    : false
  const fmtRpe = (v: string | null) => (v === null ? null : rpeAt && !v.startsWith('@') ? `@${v}` : v)

  // Rewrite each week-block from the new program; clear unfilled slots.
  for (let w = 0; w < newWeeks; w++) {
    const blockTop = top + w * rowStride
    geom.days.forEach((day, dSeq) => {
      // Vertical templates fall back to the program's days in order (their day
      // labels aren't reliably real weekdays); the column-axis path does the
      // weekday match. Either way the template's labels are left untouched.
      const dayExs = prog.byWeekday[w]?.get(prog.seqWeekdays[dSeq]) ?? []
      day.slots.forEach((slot, i) => {
        const ex = dayExs[i] ?? null
        const subSet = isSubSetOf(ex, i > 0 ? dayExs[i - 1] ?? null : null)
        const r = blockTop + slot.relRow
        const set = (col: number | null, value: ExcelJS.CellValue) => { if (col !== null) ws.getCell(r, col).value = value }
        if (slot.cols.name !== null) {
          const cell = ws.getCell(r, slot.cols.name)
          cell.value = ex ? (subSet ? '' : ex.name) : null
          clearBold(cell)
        }
        set(slot.cols.sets, ex ? ex.sets ?? null : null)
        set(slot.cols.reps, ex ? ex.reps ?? null : null)
        set(slot.cols.intensity, ex ? ex.intensity ?? null : null)
        set(slot.cols.restTime, ex ? ex.rest_time ?? null : null)
        if (slot.cols.loadCap !== null) {
          // Template splits prescribed (cap) from actual (used) — route each.
          set(slot.cols.loadCap, ex ? (ex.weight ?? null) : null)
          set(slot.cols.load, ex ? (usedLoad(ex) ?? null) : null)
        } else {
          set(slot.cols.load, ex ? (loadValue(ex) ?? null) : null)
        }
        set(slot.cols.rpe, ex ? fmtRpe(rpeValue(ex)) : null)
        set(slot.cols.erpe, null)
      })
    })
    // Renumber the week banner in this block.
    for (let r = blockTop; r < blockTop + rowStride; r++) {
      for (let c = 1; c <= maxCol; c++) {
        const cell = ws.getCell(r, c)
        if (typeof cell.value === 'string' && WEEK_BANNER.test(cell.value)) { cell.value = `Week ${w + 1}`; break }
      }
    }
  }

  return Buffer.from((await ws.workbook.xlsx.writeBuffer()) as ArrayBuffer)
}
// A movement row of the template's FIRST week — the row skeleton replicated across weeks.
interface Slot { row: number; rel: RelCols; sharedNameCol: number | null }
interface DaySkel { dayIndex: number; slots: Slot[] }

interface ColumnGeometry {
  blockStart0: number   // 1-based col where week-0's block data starts
  stride: number        // columns between consecutive weeks (incl. any gap)
  templateWeeks: number
  sharedNameCol: number | null // a single movement-name column shared by all weeks, else null
  days: DaySkel[]
  bannerRow: number     // first row carrying a "Week n" banner
  lastRow: number       // last movement row
}

/** Derive the column-axis geometry from the parser's per-row data-cell positions. */
function deriveColumnGeometry(tEx: ExternalExerciseRow[]): ColumnGeometry | null {
  const weeks = [...new Set(tEx.map((e) => e.weekIndex))].sort((a, b) => a - b)
  if (weeks.length === 0) return null

  const nameColOf = (w: number) => {
    const names = tEx.filter((e) => e.weekIndex === w).map((e) => e.refillCols!.name).filter((n): n is number => n !== null)
    return names.length ? Math.min(...names) : null
  }
  // A single movement-name column reused by every week ⇒ a shared name column
  // (some horizontal layouts); otherwise the name lives inside each week-block.
  const name0 = nameColOf(weeks[0])
  const name1 = weeks.length >= 2 ? nameColOf(weeks[1]) : null
  const sharedNameCol = name0 !== null && name0 === name1 ? name0 : null

  // Columns that belong to a week-block: data fields always, plus the name when
  // it is per-block (so the block start covers the whole block, not just data).
  const blockCols = (e: ExternalExerciseRow): number[] => {
    const c = e.refillCols!
    const cols = [c.sets, c.reps, c.load, c.rpe, c.erpe]
    if (sharedNameCol === null) cols.push(c.name)
    return cols.filter((n): n is number => n !== null)
  }
  const blockStartOf = (w: number) => {
    const cols = tEx.filter((e) => e.weekIndex === w).flatMap(blockCols)
    return cols.length ? Math.min(...cols) : Infinity
  }

  const start0 = blockStartOf(weeks[0])
  if (!isFinite(start0)) return null

  // Column axis = the block start advances across weeks. (Row axis ⇒ vertical ⇒ caller falls back.)
  let stride: number
  if (weeks.length >= 2) {
    const start1 = blockStartOf(weeks[1])
    if (!isFinite(start1) || start1 <= start0) return null // not column-axis
    stride = (start1 - start0) / (weeks[1] - weeks[0])
  } else {
    const maxCol = Math.max(...tEx.flatMap(blockCols))
    stride = maxCol - start0 + 2 // single-week template: best-effort block width + 1 gap
  }

  // Row skeleton from the first week, grouped into days (preserving sheet order).
  const week0 = tEx.filter((e) => e.weekIndex === weeks[0]).sort((a, b) => a.sheetRow - b.sheetRow)
  const days: DaySkel[] = []
  for (const e of week0) {
    const c = e.refillCols!
    const rel: RelCols = {
      name: sharedNameCol === null && c.name !== null ? c.name - start0 : null,
      sets: c.sets !== null ? c.sets - start0 : null,
      reps: c.reps !== null ? c.reps - start0 : null,
      load: c.load !== null ? c.load - start0 : null,
      loadCap: c.loadCap !== null && c.loadCap !== undefined ? c.loadCap - start0 : null,
      intensity: c.intensity !== null && c.intensity !== undefined ? c.intensity - start0 : null,
      restTime: c.restTime !== null && c.restTime !== undefined ? c.restTime - start0 : null,
      rpe: c.rpe !== null ? c.rpe - start0 : null,
      erpe: c.erpe !== null ? c.erpe - start0 : null,
    }
    let day = days.find((d) => d.dayIndex === e.dayIndex)
    if (!day) { day = { dayIndex: e.dayIndex, slots: [] }; days.push(day) }
    day.slots.push({ row: e.sheetRow, rel, sharedNameCol })
  }
  if (days.length === 0) return null

  const bannerRow = Math.min(...week0.map((e) => e.sheetRow))
  return {
    blockStart0: start0,
    stride,
    templateWeeks: weeks.length,
    sharedNameCol,
    days,
    bannerRow,
    lastRow: Math.max(...tEx.map((e) => e.sheetRow)),
  }
}

/**
 * Add day-sections for weekdays the program trains but the parser skipped because
 * the template leaves them empty (a label + blank "notes:" row the coach uses as a
 * rest day). Without this a session moved onto such a day would have nowhere to go.
 * Slots are synthesised from the blank rows under the day's own label, reusing the
 * shared column layout, and grown later by the row-insertion pass if needed. Only
 * meaningful in weekday-mode (the template labels its days by real weekday).
 */
function injectEmptyTrainedSections(ws: ExcelJS.Worksheet, geom: ColumnGeometry, trainedDays: Set<number>): void {
  const donor = geom.days[0]
  if (!donor || donor.slots.length === 0) return
  const present = new Set(geom.days.map((d) => d.dayIndex))
  const missing = [...trainedDays].filter((d) => !present.has(d))
  if (missing.length === 0) return

  // Every day-label row in the lead area (cols 1..blockStart0) with the weekday it
  // denotes — a real weekday word (Monday/Tisdag) OR "DAY n" (→ weekday n-1, the
  // Monday..Sunday = DAY 1..7 convention).
  const labelRows: Array<{ row: number; weekday: number }> = []
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= geom.blockStart0; c++) {
      const v = ws.getCell(r, c).value
      if (typeof v !== 'string') continue
      const t = v.trim()
      let wd: number | null = null
      if (t.length <= 10 && !/\d/.test(t) && WEEKDAY.test(t)) wd = weekdayOffset(t)
      else { const m = t.match(/^day\s*(\d+)/i); if (m) wd = parseInt(m[1], 10) - 1 }
      if (wd !== null && wd >= 0 && wd <= 6) { labelRows.push({ row: r, weekday: wd }); break }
    }
  }

  // Rows from a section's label down to its first movement (1 when the label row also
  // carries the column headers, as horizontal; 2 when "DAY n" has a separate header
  // row, as block-grid) — measured from the donor so it fits this template's shape.
  const donorLabel = labelRows.filter((l) => l.row <= donor.slots[0].row).map((l) => l.row)
  const headerOffset = donorLabel.length ? Math.max(1, donor.slots[0].row - Math.max(...donorLabel)) : 1
  const { rel, sharedNameCol } = donor.slots[0]
  for (const wd of missing) {
    const label = labelRows.find((l) => l.weekday === wd)
    if (!label) continue // template has no row for this weekday → can't place it
    const below = labelRows.filter((l) => l.row > label.row).map((l) => l.row)
    const start = label.row + headerOffset
    const end = below.length ? Math.min(...below) - 1 : start + donor.slots.length - 1
    const slots: Slot[] = []
    for (let r = start; r <= Math.max(start, end); r++) slots.push({ row: r, rel, sharedNameCol })
    geom.days.push({ dayIndex: wd, slots })
    geom.lastRow = Math.max(geom.lastRow, slots[slots.length - 1].row)
  }
  geom.days.sort((a, b) => a.slots[0].row - b.slots[0].row)
}

/**
 * Group the new program's exercises by week and WEEKDAY (0=Mon..6=Sun, taken
 * straight from each workout's scheduled date — i.e. the day editor). The exporter
 * places a weekday's movements into the template's matching-weekday section, so the
 * sheet always reflects the day editor exactly. `seqWeekdays` is the sorted set of
 * trained weekdays, used as the positional fallback for "Day n" templates that
 * carry no real weekday.
 */
function buildProgramContent(program: ProgramRow, workouts: WorkoutRow[], exercises: ExerciseRow[]) {
  const startMonday = mondayIso(program.start_date!)
  const dateByWorkout = new Map<string, string>()
  for (const w of workouts) if (w.scheduled_date) dateByWorkout.set(w.id, w.scheduled_date)

  type Loc = { week: number; day: number; ex: ExerciseRow }
  const located: Loc[] = []
  for (const ex of exercises) {
    const date = dateByWorkout.get(ex.workout_id)
    if (!date) continue
    const off = daysBetween(startMonday, date)
    if (off < 0) continue
    located.push({ week: Math.floor(off / 7), day: off % 7, ex })
  }
  if (located.length === 0) return null

  const weeks = [...new Set(located.map((l) => l.week))].sort((a, b) => a - b)
  const seqWeekdays = [...new Set(located.map((l) => l.day))].sort((a, b) => a - b)

  // byWeekday[weekSeq].get(weekday) = that day's ordered movements.
  const byWeekday: Array<Map<number, ExerciseRow[]>> = weeks.map(() => new Map())
  located.forEach((l) => {
    const wSeq = weeks.indexOf(l.week)
    const m = byWeekday[wSeq]
    if (!m.has(l.day)) m.set(l.day, [])
    m.get(l.day)!.push(l.ex)
  })
  for (const m of byWeekday) for (const list of m.values()) list.sort((a, b) => a.order_index - b.order_index)
  return { weekCount: weeks.length, byWeekday, seqWeekdays }
}

export async function renderScaffold(
  templateBase64: string,
  program: ProgramRow,
  workouts: WorkoutRow[],
  exercises: ExerciseRow[],
): Promise<Buffer | null> {
  if (!program.start_date) return null
  const buffer = Buffer.from(templateBase64, 'base64')

  const preview = await parseExternalFile(buffer)
  const tEx = preview.exercises.filter((e) => e.refillCols && e.refillCols.sets !== null)
  if (tEx.length === 0) return null

  const prog = buildProgramContent(program, workouts, exercises)
  if (!prog || prog.weekCount === 0) return null
  const newWeeks = prog.weekCount

  const geom = deriveColumnGeometry(tEx)
  if (!geom) return renderRowAxis(buffer, tEx, prog) // vertical (weeks stacked); null ⇒ descriptor fallback

  // Each section is filled with the program's movements for ITS weekday — the parser
  // sets geom.days[k].dayIndex from a real weekday label (Monday, Tisdag, …) OR from
  // a "DAY n" label as n-1. Real weekday labels always map by weekday. "DAY n" is
  // ambiguous: coaches use "DAY 1..7" to mean Monday..Sunday (a full-week calendar),
  // but a PARTIAL "DAY 1..N" (N < 7) is a sequential split — its sections must take
  // the program's training days IN ORDER, not by weekday, or a gapped week (e.g.
  // Tue/Thu/Sun) would skip sections and drop sessions. So "DAY n" only maps by
  // weekday when the template spans the whole week (DAY 7 present); otherwise it
  // falls back to the program's days in order, like a non-weekday/non-"DAY n"
  // template. The coach's labels are never renamed.
  const hasWeekdayLabel = tEx.some((e) => WEEKDAY.test((e.dayLabel ?? '').trim()))
  const hasDayN = tEx.some((e) => DAY_N.test((e.dayLabel ?? '').trim()))
  const maxTemplateDay = Math.max(...geom.days.map((d) => d.dayIndex))
  const weekdayMode = hasWeekdayLabel || (hasDayN && maxTemplateDay >= 6)
  const dayExsFor = (w: number, dSeq: number, dayIndex: number): ExerciseRow[] =>
    prog.byWeekday[w]?.get(weekdayMode ? dayIndex : prog.seqWeekdays[dSeq]) ?? []
  // Movements for naming a shared (write-once) name column: take them from the first
  // week that actually trains the day, since week 0 may not (e.g. a day added later).
  const firstNonEmptyDayExs = (dSeq: number, dayIndex: number): ExerciseRow[] => {
    for (let w = 0; w < newWeeks; w++) { const e = dayExsFor(w, dSeq, dayIndex); if (e.length) return e }
    return []
  }

  // Clone the original (keeps chrome, form link, merges, styles intact).
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  let ws = wb.worksheets[0]
  if (!ws) return null
  detachSharedFormulas(ws)

  // Give weekdays the program trains but the template left empty a real section to
  // fill (e.g. a session moved onto the coach's blank Thursday row).
  if (weekdayMode) {
    injectEmptyTrainedSections(ws, geom, new Set(prog.byWeekday.flatMap((m) => [...m.keys()])))
  }

  const { blockStart0, stride, templateWeeks } = geom
  let lastRow = geom.lastRow

  // 0. Row insertion — if a program day has MORE movements than the template's
  // first week, grow that day by duplicating its last movement row (shared across
  // all week-columns). Processed top-down with a running shift so later rows stay
  // addressable; formulas in the new rows are blanked (a copied shared formula
  // has no master).
  {
    let shift = 0
    for (let dSeq = 0; dSeq < geom.days.length; dSeq++) {
      const day = geom.days[dSeq]
      day.slots = day.slots.map((s) => ({ ...s, row: s.row + shift }))
      const capacity = day.slots.length
      if (capacity === 0) continue
      const needed = Math.max(0, ...Array.from({ length: newWeeks }, (_, w) => dayExsFor(w, dSeq, day.dayIndex).length))
      const extra = needed - capacity
      if (extra <= 0) continue
      const proto = day.slots[capacity - 1]
      ws.duplicateRow(proto.row, extra, true)
      for (let i = 1; i <= extra; i++) {
        ws.getRow(proto.row + i).eachCell({ includeEmpty: false }, (cell) => {
          if (cell.type === ExcelJS.ValueType.Formula) cell.value = null
        })
        day.slots.push({ row: proto.row + i, rel: proto.rel, sharedNameCol: proto.sharedNameCol })
      }
      shift += extra
    }
    lastRow += shift
  }

  // The block region's top row = the first "Week n" banner (above the movement
  // rows). Copying/renumbering uses this so banners + headers are included and
  // top-row chrome (e.g. the form-link button) is never duplicated into a week.
  let regionTop = geom.bannerRow
  for (let r = 1; r <= lastRow; r++) {
    let hit = false
    for (let c = blockStart0; c < blockStart0 + stride * templateWeeks; c++) {
      const v = ws.getCell(r, c).value
      if (typeof v === 'string' && WEEK_BANNER.test(v)) { hit = true; break }
    }
    if (hit) { regionTop = r; break }
  }

  // 1. Make the sheet hold exactly `newWeeks` week-blocks.
  if (newWeeks < templateWeeks) {
    // Drop the extra trailing week-blocks by rebuilding a column-prefix into a
    // fresh sheet. (ExcelJS spliceColumns corrupts hyperlinks, so we don't use it.)
    const lastKeptCol = blockStart0 + newWeeks * stride - 1
    ws = copyColumnPrefix(ws, lastKeptCol, lastRow)
  } else if (newWeeks > templateWeeks) {
    // Append copies of week-0's block (banner row downward only, so top-row chrome
    // such as the form-link button is never duplicated into new weeks).
    for (let w = templateWeeks; w < newWeeks; w++) {
      const destBase = blockStart0 + w * stride
      for (let off = 0; off < stride; off++) {
        const srcCol = blockStart0 + off
        const dstCol = destBase + off
        const width = ws.getColumn(srcCol).width
        if (width) ws.getColumn(dstCol).width = width
        for (let r = regionTop; r <= lastRow; r++) {
          const sc = ws.getCell(r, srcCol)
          const dc = ws.getCell(r, dstCol)
          dc.style = sc.style
          // Never clone a formula (e.g. e1RM): a copied shared-formula has no
          // master and breaks the writer — appended weeks start blank anyway.
          dc.value = sc.type === ExcelJS.ValueType.Formula ? null : sc.value
        }
      }
    }
  }

  // 2. @-RPE notation, sampled from the source.
  const rpeSlot = geom.days.flatMap((d) => d.slots).find((s) => s.rel.rpe !== null)
  const rpeAt = rpeSlot
    ? String(ws.getCell(rpeSlot.row, blockStart0 + rpeSlot.rel.rpe!).text ?? '').trim().startsWith('@')
    : false
  const fmtRpe = (v: string | null) => (v === null ? null : rpeAt && !v.startsWith('@') ? `@${v}` : v)

  // Movement-area rows to wipe before refilling — covers spacer / placeholder name
  // rows the parser skips (otherwise the source's movement names linger). Keeps
  // structural rows (Week banners, "DAY n" labels, repeated column headers).
  const allSlots = geom.days.flatMap((d) => d.slots)
  const firstMovementRow = Math.min(...allSlots.map((s) => s.row))
  const dataWidth = Math.max(...allSlots.flatMap((s) =>
    [s.rel.name, s.rel.sets, s.rel.reps, s.rel.load, s.rel.loadCap, s.rel.intensity, s.rel.rpe, s.rel.erpe]
      .filter((n): n is number => n !== null && n >= 0))) + 1
  const slotRows = new Set(allSlots.map((s) => s.row))
  const isStructuralRow = (r: number): boolean => {
    // A movement row that holds parsed exercises is never structural — it gets
    // refilled. Everything else with day/week/header markers must be preserved.
    if (slotRows.has(r)) return false
    let hasSet = false, hasRep = false
    for (let off = 0; off < dataWidth; off++) {
      const v = ws.getCell(r, blockStart0 + off).value
      if (typeof v !== 'string') continue
      const t = v.trim()
      if (WEEK_BANNER.test(t) || DAY_N.test(t)) return true
      // Weekday day-section label (e.g. "Torsdag") in a non-movement row.
      if (WEEKDAY.test(t) && t.length <= 10 && !/\d/.test(t)) return true
      const lower = t.toLowerCase()
      if (/\bsets?\b/.test(lower)) hasSet = true
      if (/\breps?\b/.test(lower)) hasRep = true
    }
    return hasSet && hasRep
  }
  const clearableRows: number[] = []
  for (let r = firstMovementRow; r <= lastRow; r++) {
    if (!isStructuralRow(r)) clearableRows.push(r)
  }
  // Day-label cells in the lead area (cols 1..blockStart0). A label sitting AT/right
  // of the block start repeats per week-block (block-grid / week-grid) and is later
  // normalised across weeks; a label LEFT of it (a weekday in column 1, horizontal)
  // is a single shared label and left alone.
  const isDayLabel = (v: ExcelJS.CellValue): boolean => {
    if (typeof v !== 'string') return false
    const t = v.trim()
    return DAY_N.test(t) || (WEEKDAY.test(t) && t.length <= 10 && !/\d/.test(t))
  }
  const leadLabelRows: number[] = []
  for (let r = regionTop; r <= lastRow; r++) {
    if (isStructuralRow(r) && isDayLabel(ws.getCell(r, blockStart0).value)) leadLabelRows.push(r)
  }
  // Shared movement-name column (when present) is cleared once across all weeks.
  if (geom.sharedNameCol !== null) {
    for (const r of clearableRows) ws.getCell(r, geom.sharedNameCol).value = null
  }

  // 3. Rewrite every week-block from the new program; clear unfilled slots.
  for (let w = 0; w < newWeeks; w++) {
    const base = blockStart0 + w * stride
    // Wipe the movement area of this block so no source movements remain.
    for (const r of clearableRows) {
      for (let off = 0; off < dataWidth; off++) ws.getCell(r, base + off).value = null
    }
    geom.days.forEach((day, dSeq) => {
      const dayExs = dayExsFor(w, dSeq, day.dayIndex)
      day.slots.forEach((slot, i) => {
        const ex = dayExs[i] ?? null
        const subSet = isSubSetOf(ex, i > 0 ? dayExs[i - 1] ?? null : null)
        const nameVal = ex ? (subSet ? '' : ex.name) : null
        // A column offset < 0 is a SHARED column left of the week-block (e.g. a
        // single Rest-Time / name column serving every week); it must be written
        // once (on week 0) at its absolute position, never per week-block — doing
        // the latter would land in the previous block and corrupt it.
        const set = (col: number | null, value: ExcelJS.CellValue) => {
          if (col === null) return
          if (col < 0 && w !== 0) return
          ws.getCell(slot.row, base + col).value = value
        }
        // Name: per-block column, or a single shared column (written once, on week 0).
        // Further sets of a grouped movement leave the name blank (read once). The
        // shared column names from the first week that trains the day so a day absent
        // in week 0 (but present later) still shows its movement names.
        if (slot.sharedNameCol !== null) {
          if (w === 0) {
            const rep = firstNonEmptyDayExs(dSeq, day.dayIndex)
            const repEx = rep[i] ?? null
            const repSub = isSubSetOf(repEx, i > 0 ? rep[i - 1] ?? null : null)
            const cell = ws.getCell(slot.row, slot.sharedNameCol)
            cell.value = repEx ? (repSub ? '' : repEx.name) : null
            clearBold(cell)
          }
        } else if (slot.rel.name !== null && (slot.rel.name >= 0 || w === 0)) {
          const cell = ws.getCell(slot.row, base + slot.rel.name)
          cell.value = nameVal
          clearBold(cell)
        }
        set(slot.rel.sets, ex ? ex.sets ?? null : null)
        set(slot.rel.reps, ex ? ex.reps ?? null : null)
        set(slot.rel.intensity, ex ? ex.intensity ?? null : null)
        set(slot.rel.restTime, ex ? ex.rest_time ?? null : null)
        if (slot.rel.loadCap !== null) {
          // Template splits prescribed (cap) from actual (used) — route each.
          set(slot.rel.loadCap, ex ? (ex.weight ?? null) : null)
          set(slot.rel.load, ex ? (usedLoad(ex) ?? null) : null)
        } else {
          set(slot.rel.load, ex ? (loadValue(ex) ?? null) : null)
        }
        set(slot.rel.rpe, ex ? fmtRpe(rpeValue(ex)) : null)
        set(slot.rel.erpe, null) // executed RPE always blank in a fresh block
      })
    })

    // Renumber the week banner inside this block.
    for (let r = regionTop; r <= lastRow; r++) {
      for (let c = base; c < base + stride; c++) {
        const cell = ws.getCell(r, c)
        if (typeof cell.value === 'string' && WEEK_BANNER.test(cell.value)) {
          cell.value = `Week ${w + 1}`
        }
      }
    }
  }

  // Day-section labels are the coach's own (Monday, Tisdag, "DAY 1", …) and are
  // never rewritten — movements are routed to the section that already carries their
  // weekday, so the sheet matches the day editor without touching a single label
  // (the v1.9.0 behaviour). Empty template days likewise just stay empty.
  //
  // The one exception: per-week-block lead labels (block-grid / week-grid repeat the
  // day label in each week's block) are normalised to week 1's wording, since some
  // templates are inconsistent (week 1 "Tisdag", week 2 "Day 1").
  for (const r of leadLabelRows) {
    const canonical = ws.getCell(r, blockStart0).value
    for (let w = 1; w < newWeeks; w++) ws.getCell(r, blockStart0 + w * stride).value = canonical
  }

  return Buffer.from((await ws.workbook.xlsx.writeBuffer()) as ArrayBuffer)
}
