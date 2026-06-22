import ExcelJS from 'exceljs'
import { analyzeScaffold, type ScaffoldGeometry } from './externalImportService.js'

// ---------------------------------------------------------------------------
// Scaffold export (Feature: export style templates v2).
//
// A saved style is treated as a reusable SCAFFOLD, not a fixed file:
//   • the chrome (decorative boxes, Coach Notes, the working form-link button)
//     is copied verbatim once;
//   • ONE week-block's structure + cell styles (colours, fonts, borders, the
//     column layout incl. eRPE) is captured and re-stamped per week;
//   • all content — week count, days, movements, numbers — comes from the NEW
//     program, so nothing from the source program leaks through.
//
// Generic over any block-grid sheet (no per-file hardcoding). Returns null when
// the sheet isn't a block-grid we can analyse, so the caller falls back to the
// descriptor renderer.
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

// One movement slot in the canonical structure (shared row across all weeks).
interface Slot { name: string; row: number }
interface Day { seqDay: number; dayHeaderRow: number; colHeaderRow: number; slots: Slot[] }

/** Group the new program's exercises into weeks → sequential days → ordered movements. */
function buildProgramStructure(program: ProgramRow, workouts: WorkoutRow[], exercises: ExerciseRow[]) {
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

  // Sequential day index within each week (calendar weekday → 0,1,2…).
  const weeks = [...new Set(located.map((l) => l.week))].sort((a, b) => a - b)
  const seqByWeek = new Map<number, Map<number, number>>()
  for (const w of weeks) {
    const days = [...new Set(located.filter((l) => l.week === w).map((l) => l.day))].sort((a, b) => a - b)
    seqByWeek.set(w, new Map(days.map((d, i) => [d, i])))
  }

  // Per (week, seqDay) ordered exercise list.
  const byWeekDay = new Map<string, ExerciseRow[]>()
  for (const l of located) {
    const seq = seqByWeek.get(l.week)!.get(l.day)!
    const key = `${l.week}-${seq}`
    if (!byWeekDay.has(key)) byWeekDay.set(key, [])
    byWeekDay.get(key)!.push(l.ex)
  }
  for (const list of byWeekDay.values()) list.sort((a, b) => a.order_index - b.order_index)

  // Canonical day list: union of seqDays; per day, the longest movement list seen.
  const seqDays = [...new Set([...byWeekDay.keys()].map((k) => Number(k.split('-')[1])))].sort((a, b) => a - b)
  const canonicalNames = new Map<number, string[]>()
  for (const sd of seqDays) {
    let names: string[] = []
    for (const w of weeks) {
      const list = byWeekDay.get(`${w}-${sd}`) ?? []
      if (list.length > names.length) names = list.map((e) => e.name)
    }
    canonicalNames.set(sd, names)
  }

  return { weeks, seqDays, canonicalNames, byWeekDay }
}

export async function renderScaffold(
  templateBase64: string,
  program: ProgramRow,
  workouts: WorkoutRow[],
  exercises: ExerciseRow[],
): Promise<Buffer | null> {
  if (!program.start_date) return null
  const buffer = Buffer.from(templateBase64, 'base64')

  const geom = await analyzeScaffold(buffer)
  if (!geom) return null

  const structure = buildProgramStructure(program, workouts, exercises)
  if (!structure || structure.weeks.length === 0) return null
  const { weeks, seqDays, canonicalNames, byWeekDay } = structure

  // Source workbook = style provider (read styles, chrome, merges, widths).
  const srcWb = new ExcelJS.Workbook()
  await srcWb.xlsx.load(buffer as unknown as ArrayBuffer)
  const src = srcWb.worksheets[0]
  if (!src) return null

  // Build the row skeleton (shared across all week-blocks) from the canonical days.
  let r = geom.bannerRow
  const days: Day[] = []
  for (const sd of seqDays) {
    const names = canonicalNames.get(sd) ?? []
    const dayHeaderRow = r
    const colHeaderRow = r + 1
    const slots: Slot[] = names.map((name, i) => ({ name, row: colHeaderRow + 1 + i }))
    days.push({ seqDay: sd, dayHeaderRow, colHeaderRow, slots })
    r = colHeaderRow + 1 + slots.length + 1 // movements + one blank separator row
  }

  // Output workbook.
  const outWb = new ExcelJS.Workbook()
  const out = outWb.addWorksheet(geom.sheetName)

  // 1. Copy the chrome region verbatim (values, styles, hyperlinks, row heights).
  for (let row = 1; row <= geom.chromeRows; row++) {
    const srcRow = src.getRow(row)
    const outRow = out.getRow(row)
    if (srcRow.height) outRow.height = srcRow.height
    srcRow.eachCell({ includeEmpty: false }, (cell, col) => {
      const oc = out.getCell(row, col)
      oc.value = cell.value          // hyperlink cells carry {text, hyperlink}
      oc.style = cell.style
    })
  }
  // Re-create merges that live entirely within the chrome region.
  const merges: string[] = (src.model?.merges as string[] | undefined)
    ?? Object.keys((src as unknown as { _merges?: Record<string, unknown> })._merges ?? {})
  for (const range of merges) {
    const m = range.match(/^[A-Z]+(\d+):[A-Z]+(\d+)$/)
    if (m && Number(m[1]) <= geom.chromeRows && Number(m[2]) <= geom.chromeRows) {
      try { out.mergeCells(range) } catch { /* ignore overlaps */ }
    }
  }

  // 2. Column widths: chrome columns from source; block columns by offset.
  const totalWeeks = weeks.length
  const lastCol = geom.blockStartCol + totalWeeks * geom.blockWidth
  for (let col = 1; col < geom.blockStartCol; col++) {
    const w = src.getColumn(col).width
    if (w) out.getColumn(col).width = w
  }
  for (let w = 0; w < totalWeeks; w++) {
    const base = geom.blockStartCol + w * geom.blockWidth
    geom.colWidths.forEach((width, off) => { if (width) out.getColumn(base + off).width = width })
  }
  void lastCol

  // 3. Captured style prototypes + day-label format from the source.
  const styleAt = ([row, col]: [number, number]) => src.getCell(row, col).style
  const dayProto = styleAt(geom.styleRefs.dayBanner)
  const weekProto = styleAt(geom.styleRefs.weekBanner)
  const headerProto = styleAt(geom.styleRefs.header)
  const nameProto = styleAt(geom.styleRefs.name)
  const bodyProto = styleAt(geom.styleRefs.body)

  const dayLabelText = String(src.getCell(...geom.styleRefs.dayBanner).text ?? 'DAY 1')
  const dayLabel = (i: number) => dayLabelText.replace(/\d+/, String(i + 1)) || `DAY ${i + 1}`

  const rpeCol = geom.columns.find((c) => c.key === 'rpe')
  const rpeAt = rpeCol
    ? String(src.getCell(geom.firstDataRow, geom.blockStartCol + rpeCol.offset).text ?? '').trim().startsWith('@')
    : false
  const fmtRpe = (v: string | null) => (v === null ? null : rpeAt && !v.startsWith('@') ? `@${v}` : v)

  // 4. Stamp one styled, content-filled block per program week.
  weeks.forEach((weekNo, wIdx) => {
    const base = geom.blockStartCol + wIdx * geom.blockWidth
    for (let di = 0; di < days.length; di++) {
      const day = days[di]

      // Day banner (lead col) + the "Week n" banner on day 0's row.
      const dayCell = out.getCell(day.dayHeaderRow, base)
      dayCell.value = dayLabel(di)
      dayCell.style = dayProto
      if (di === 0) {
        const wkCell = out.getCell(day.dayHeaderRow, base + geom.weekBannerOffset)
        wkCell.value = `Week ${wIdx + 1}`
        wkCell.style = weekProto
      }

      // Column header row.
      for (const col of geom.columns) {
        const hc = out.getCell(day.colHeaderRow, base + col.offset)
        hc.value = col.label
        hc.style = headerProto
      }

      // Movement rows for this week.
      const list = byWeekDay.get(`${weekNo}-${day.seqDay}`) ?? []
      day.slots.forEach((slot, i) => {
        const ex = list[i] ?? null
        for (const col of geom.columns) {
          const cell = out.getCell(slot.row, base + col.offset)
          cell.style = col.key === 'name' ? nameProto : bodyProto
          if (col.key === 'name') { cell.value = slot.name || null; continue }
          if (!ex) { cell.value = null; continue }
          switch (col.key) {
            case 'sets': cell.value = ex.sets ?? null; break
            case 'reps': cell.value = ex.reps ?? null; break
            case 'load': { const lv = loadValue(ex); cell.value = lv === null ? null : lv; break }
            case 'rpe': cell.value = fmtRpe(rpeValue(ex)); break
            case 'erpe': cell.value = null; break // executed RPE always blank in a fresh block
          }
        }
      })
    }
  })

  return Buffer.from((await outWb.xlsx.writeBuffer()) as ArrayBuffer)
}
