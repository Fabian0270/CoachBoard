import ExcelJS from 'exceljs'
import { parseExternalFile } from './externalImportService.js'
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
  rpe: string | null
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
  if (ex.load_used) {
    const n = parseFloat(ex.load_used.replace(',', '.'))
    return isNaN(n) ? ex.load_used : n
  }
  return null
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

interface RelCols { name: number | null; sets: number | null; reps: number | null; load: number | null; rpe: number | null; erpe: number | null }

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
    const slot: RowSlot = { relRow: e.sheetRow - top, cols: { name: c.name, sets: c.sets, reps: c.reps, load: c.load, rpe: c.rpe, erpe: c.erpe } }
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
  prog: { weekCount: number; content: ExerciseRow[][][] },
): Promise<Buffer | null> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  let ws = wb.worksheets[0]
  if (!ws) return null

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
      const dayExs = prog.content[w]?.[dSeq] ?? []
      day.slots.forEach((slot, i) => {
        const ex = dayExs[i] ?? null
        const r = blockTop + slot.relRow
        const set = (col: number | null, value: ExcelJS.CellValue) => { if (col !== null) ws.getCell(r, col).value = value }
        set(slot.cols.name, ex ? ex.name : null)
        set(slot.cols.sets, ex ? ex.sets ?? null : null)
        set(slot.cols.reps, ex ? ex.reps ?? null : null)
        set(slot.cols.load, ex ? (loadValue(ex) ?? null) : null)
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

/** Group the new program's exercises into weeks → sequential days → ordered movements. */
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
  const seqByWeek = new Map<number, Map<number, number>>()
  for (const w of weeks) {
    const days = [...new Set(located.filter((l) => l.week === w).map((l) => l.day))].sort((a, b) => a - b)
    seqByWeek.set(w, new Map(days.map((d, i) => [d, i])))
  }

  // content[weekSeq][daySeq] = ordered exercises
  const content: ExerciseRow[][][] = weeks.map(() => [])
  located.forEach((l) => {
    const wSeq = weeks.indexOf(l.week)
    const dSeq = seqByWeek.get(l.week)!.get(l.day)!
    ;(content[wSeq][dSeq] ??= []).push(l.ex)
  })
  for (const week of content) for (const day of week) day?.sort((a, b) => a.order_index - b.order_index)
  return { weekCount: weeks.length, content }
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

  // Clone the original (keeps chrome, form link, merges, styles intact).
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  let ws = wb.worksheets[0]
  if (!ws) return null

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
      const needed = Math.max(0, ...Array.from({ length: newWeeks }, (_, w) => prog.content[w]?.[dSeq]?.length ?? 0))
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
    [s.rel.name, s.rel.sets, s.rel.reps, s.rel.load, s.rel.rpe, s.rel.erpe].filter((n): n is number => n !== null))) + 1
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
  // Day-section label rows (weekday or "Day n" in the block's lead column) — used
  // to normalise the label across every week (templates are sometimes inconsistent,
  // e.g. week 1 says "Tisdag" but weeks 2-3 say "Day 1").
  const dayLabelRows: number[] = []
  const isDayLabel = (v: ExcelJS.CellValue): boolean => {
    if (typeof v !== 'string') return false
    const t = v.trim()
    return DAY_N.test(t) || (WEEKDAY.test(t) && t.length <= 10 && !/\d/.test(t))
  }
  for (let r = firstMovementRow; r <= lastRow; r++) {
    if (!isStructuralRow(r)) clearableRows.push(r)
  }
  // Day labels can sit on the first day's header row (above the first movement),
  // so scan the whole region from its top.
  for (let r = regionTop; r <= lastRow; r++) {
    if (isStructuralRow(r) && isDayLabel(ws.getCell(r, blockStart0).value)) dayLabelRows.push(r)
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
      const dayExs = prog.content[w]?.[dSeq] ?? []
      day.slots.forEach((slot, i) => {
        const ex = dayExs[i] ?? null
        const set = (col: number | null, value: ExcelJS.CellValue) => {
          if (col !== null) ws.getCell(slot.row, base + col).value = value
        }
        // Name: per-block column, or a single shared column (written once, on week 0).
        if (slot.sharedNameCol !== null) {
          if (w === 0) ws.getCell(slot.row, slot.sharedNameCol).value = ex ? ex.name : null
        } else {
          set(slot.rel.name, ex ? ex.name : null)
        }
        set(slot.rel.sets, ex ? ex.sets ?? null : null)
        set(slot.rel.reps, ex ? ex.reps ?? null : null)
        set(slot.rel.load, ex ? (loadValue(ex) ?? null) : null)
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

  // Normalise day-section labels to the first week's wording across every week.
  for (const r of dayLabelRows) {
    const canonical = ws.getCell(r, blockStart0).value
    for (let w = 1; w < newWeeks; w++) ws.getCell(r, blockStart0 + w * stride).value = canonical
  }

  return Buffer.from((await ws.workbook.xlsx.writeBuffer()) as ArrayBuffer)
}
