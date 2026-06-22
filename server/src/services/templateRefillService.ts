import ExcelJS from 'exceljs'
import { parseExternalFile } from './externalImportService.js'

// ---------------------------------------------------------------------------
// Template re-fill — the high-fidelity export path.
//
// The original imported .xlsx is kept verbatim. To export a program that is
// based on it, we LOAD the real file and overwrite only the data cells
// (sets/reps/load/rpe) with the new program's numbers, clearing executed (eRPE)
// cells. Everything else — hyperlinks (e.g. the coach's Google Form button),
// merged header boxes, the Microcycle legend, formulas, exact colours/layout —
// is preserved because we never regenerate it.
//
// Matching is by (week, sequential-day, movement-name, occurrence): robust for
// programs derived from the same source, which line up closely. Returns null
// when nothing lines up, so the caller can fall back to the descriptor renderer.
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

const normName = (s: string) => s.trim().toLowerCase()

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number)
  const [ty, tm, td] = toIso.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000)
}

function mondayIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
  return date.toISOString().slice(0, 10)
}

/** Map "week-day" → sequential day index within its week (0,1,2…). */
function seqDayMap(items: Array<{ week: number; day: number }>): Map<string, number> {
  const byWeek = new Map<number, Set<number>>()
  for (const it of items) {
    if (!byWeek.has(it.week)) byWeek.set(it.week, new Set())
    byWeek.get(it.week)!.add(it.day)
  }
  const result = new Map<string, number>()
  for (const [week, days] of byWeek) {
    ;[...days].sort((a, b) => a - b).forEach((d, i) => result.set(`${week}-${d}`, i))
  }
  return result
}

/** Prescribed load number for a cell, or '' to blank it. */
function loadValue(ex: ExerciseRow): number | string {
  if (ex.weight !== null && ex.weight !== undefined) return ex.weight
  if (ex.load_used) {
    const n = parseFloat(ex.load_used.replace(',', '.'))
    if (!isNaN(n)) return n
    return ex.load_used
  }
  return ''
}

/** Prescribed RPE text (digits/range), pulling from rpe then an "RPE n" intensity. */
function rpeValue(ex: ExerciseRow): string | null {
  if (ex.rpe !== null && ex.rpe !== '') return String(ex.rpe)
  if (ex.intensity && /rpe|^@/i.test(ex.intensity.trim())) {
    const m = ex.intensity.match(/(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)/)
    if (m) return m[1].replace(/\s+/g, '')
  }
  return null
}

export async function refillTemplate(
  templateBase64: string,
  program: ProgramRow,
  workouts: WorkoutRow[],
  exercises: ExerciseRow[],
): Promise<Buffer | null> {
  if (!program.start_date) return null
  const originalBuffer = Buffer.from(templateBase64, 'base64')

  // 1. Geometry of the original file: each template row's data-cell columns.
  const preview = await parseExternalFile(originalBuffer)
  const templateRows = preview.exercises.filter((e) => e.refillCols)
  if (templateRows.length === 0) return null

  // Template blocks keyed by (week, sequential-day).
  const tSeq = seqDayMap(templateRows.map((e) => ({ week: e.weekIndex, day: e.dayIndex })))
  const templateBlocks = new Map<string, typeof templateRows>()
  for (const e of templateRows) {
    const key = `${e.weekIndex}-${tSeq.get(`${e.weekIndex}-${e.dayIndex}`)}`
    if (!templateBlocks.has(key)) templateBlocks.set(key, [])
    templateBlocks.get(key)!.push(e)
  }

  // 2. New program's exercises located on the calendar, keyed the same way.
  const startMonday = mondayIso(program.start_date)
  const dateByWorkout = new Map<string, string>()
  for (const w of workouts) if (w.scheduled_date) dateByWorkout.set(w.id, w.scheduled_date)

  type Located = { week: number; day: number; ex: ExerciseRow }
  const located: Located[] = []
  for (const ex of exercises) {
    const date = dateByWorkout.get(ex.workout_id)
    if (!date) continue
    const off = daysBetween(startMonday, date)
    if (off < 0) continue
    located.push({ week: Math.floor(off / 7), day: off % 7, ex })
  }
  if (located.length === 0) return null

  const nSeq = seqDayMap(located.map((l) => ({ week: l.week, day: l.day })))
  const newBlocks = new Map<string, ExerciseRow[]>()
  for (const l of located) {
    const key = `${l.week}-${nSeq.get(`${l.week}-${l.day}`)}`
    if (!newBlocks.has(key)) newBlocks.set(key, [])
    newBlocks.get(key)!.push(l.ex)
  }
  for (const list of newBlocks.values()) list.sort((a, b) => a.order_index - b.order_index)

  // 3. Load the real workbook for writing and detect the @-RPE notation.
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(originalBuffer as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) return null

  let rpeAt = false
  for (const t of templateRows) {
    if (t.refillCols!.rpe) {
      rpeAt = String(ws.getCell(t.sheetRow, t.refillCols!.rpe).text ?? '').trim().startsWith('@')
      break
    }
  }
  const fmtRpe = (v: string | null) => (v === null ? null : rpeAt && !v.startsWith('@') ? `@${v}` : v)

  // 4. For each template block that has a matching new block, clear its data
  // cells then write the new program's numbers (matched by name + occurrence).
  let filledAny = false
  for (const [key, tRows] of templateBlocks) {
    const newList = newBlocks.get(key)
    if (!newList) continue // template block with no new counterpart → leave as-is

    // Per-name FIFO queue of the new program's exercises in this block.
    const queues = new Map<string, ExerciseRow[]>()
    for (const ex of newList) {
      const k = normName(ex.name)
      if (!queues.has(k)) queues.set(k, [])
      queues.get(k)!.push(ex)
    }

    for (const t of tRows) {
      const cols = t.refillCols!
      // Clear this row's writable + executed cells first (fresh block).
      for (const c of [cols.sets, cols.reps, cols.load, cols.rpe, cols.erpe]) {
        if (c) ws.getCell(t.sheetRow, c).value = null
      }
      const match = queues.get(normName(t.name))?.shift()
      if (!match) continue
      filledAny = true
      if (cols.sets) ws.getCell(t.sheetRow, cols.sets).value = match.sets ?? null
      if (cols.reps) ws.getCell(t.sheetRow, cols.reps).value = match.reps ?? null
      if (cols.load) {
        const lv = loadValue(match)
        ws.getCell(t.sheetRow, cols.load).value = lv === '' ? null : lv
      }
      if (cols.rpe) ws.getCell(t.sheetRow, cols.rpe).value = fmtRpe(rpeValue(match))
    }
  }

  if (!filledAny) return null
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}
