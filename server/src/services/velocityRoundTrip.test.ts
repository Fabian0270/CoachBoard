import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import type { ExportLayoutTemplate } from 'coachboard-shared'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import { createProgram, setProgramDuration, createWorkout, createExercise } from './programService.js'
import { buildProgramWorkbook } from './programExport.js'
import { parseImportFile } from './importService.js'
import { resolveHeaderRow } from './external-import/headerDetection.js'

// ---------------------------------------------------------------------------
// The Velocity column (BP39, D71, D73) through export → athlete fills in
// results → import, the way cueRoundTrip.test.ts runs the cue column. With it
// on, CoachBoard's looks get a Velocity column; a coach's style takes its own
// velocity column if it has one, else the target after the Intensity text.
// With it off, the sheet is what it always was.
// ---------------------------------------------------------------------------

const PLAN = [
  { name: 'Squat', sets: '3', reps: '5', intensity: 'RPE 8', velocity: '0.50 · VL 20%' },
  { name: 'Bench Press', sets: '3', reps: '8', intensity: 'RPE 7', velocity: null },
]
const DATES = ['2026-06-08', '2026-06-15']

const STYLE = (columns: ExportLayoutTemplate['columns']): ExportLayoutTemplate => ({
  version: 1,
  orientation: 'horizontal',
  columns,
  dayLabels: { style: 'weekday', language: 'en' },
  rpeNotation: 'plain',
  colors: { weekBanner: null, dayHeader: null, columnHeader: null, trackingHeader: null, body: null },
  fonts: { headerBold: true, headerItalic: true, nameBold: true },
})
const WITH_INTENSITY = STYLE([
  { key: 'name', label: 'Movement' }, { key: 'sets', label: 'Sets' }, { key: 'reps', label: 'Reps' },
  { key: 'intensity', label: 'Target' }, { key: 'load_used', label: 'Load Used' }, { key: 'rpe', label: 'Last Set RPE' },
])
const WITH_VELOCITY = STYLE([
  { key: 'name', label: 'Movement' }, { key: 'sets', label: 'Sets' }, { key: 'reps', label: 'Reps' },
  { key: 'intensity', label: 'Target' }, { key: 'velocity', label: 'Bar speed' },
  { key: 'load_used', label: 'Load Used' }, { key: 'rpe', label: 'Last Set RPE' },
])

let athleteId: string
beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Velocity Athlete' })).id
})

async function makeProgram(opts: { name: string; on: boolean; builtin?: string; layout?: ExportLayoutTemplate }) {
  const columns = ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe', ...(opts.on ? ['velocity'] : [])]
  const program = await createProgram({
    athlete_id: athleteId, name: opts.name, enabled_columns: columns, builtin_template: opts.builtin ?? 'coachboard',
  })
  await setProgramDuration(program.id, DATES[0], 2)
  if (opts.layout) {
    await getDb().updateTable('programs').set({ export_layout: JSON.stringify(opts.layout) }).where('id', '=', program.id).execute()
  }
  for (const date of DATES) {
    const w = await createWorkout({ program_id: program.id, name: 'Monday', scheduled_date: date })
    for (const [i, lift] of PLAN.entries()) {
      await createExercise({ workout_id: w.id, name: lift.name, sets: lift.sets, reps: lift.reps, intensity: lift.intensity, velocity: lift.velocity, order_index: i })
    }
  }
  return program.id
}

async function sheetOf(buffer: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb.worksheets[0]
}
const text = (ws: ExcelJS.Worksheet, r: number, c: number) => {
  const v = ws.getCell(r, c).value
  return v === null || v === undefined ? '' : String(v).trim()
}
const allText = (ws: ExcelJS.Worksheet) => {
  const out: string[] = []
  for (let r = 1; r <= ws.rowCount; r++) for (let c = 1; c <= ws.columnCount; c++) out.push(text(ws, r, c))
  return out
}

/** Fills Load Used and RPE under their headers, a distinct load per lift and week. */
async function fillAndImport(programId: string, labels: { name: string; loadUsed: string; rpe: string }) {
  const { buffer } = await buildProgramWorkbook(programId)
  const ws = await sheetOf(buffer)
  const written = new Map<string, number>()
  const cols = (row: number, label: string) => {
    const found: number[] = []
    for (let c = 1; c <= ws.columnCount; c++) if (text(ws, row, c) === label) found.push(c)
    return found
  }
  for (let row = 1; row <= ws.rowCount; row++) {
    const nameCols = cols(row, labels.name)
    const loadCols = cols(row, labels.loadUsed)
    const rpeCols = cols(row, labels.rpe)
    if (nameCols.length === 0 || nameCols.length !== loadCols.length) continue
    for (let body = row + 1; body <= ws.rowCount; body++) {
      if (!nameCols.some((c) => text(ws, body, c) !== '')) break
      for (const [week, nameCol] of nameCols.entries()) {
        const lift = PLAN.findIndex((l) => text(ws, body, nameCol) === l.name)
        if (lift === -1) continue
        const load = 100 + week * 10 + lift
        ws.getCell(body, loadCols[week]).value = load
        ws.getCell(body, rpeCols[week]).value = 8
        written.set(`${week}|${PLAN[lift].name}`, load)
      }
    }
  }
  const filled = Buffer.from((await ws.workbook.xlsx.writeBuffer()) as ArrayBuffer)
  expect(written.size).toBe(PLAN.length * DATES.length)
  const result = await parseImportFile(filled, programId)
  expect(result.errors).toEqual([])
  expect(result.matched.length).toBe(written.size)
  for (const m of result.matched) {
    expect(m.load_used, `${m.exerciseName} week ${m.weekIndex + 1}`).toBe(String(written.get(`${m.weekIndex}|${m.exerciseName}`)))
  }
  return allText(ws)
}

describe('Velocity column on', () => {
  it("CoachBoard's own look: a Velocity column in every week, results read back right", async () => {
    const cells = await fillAndImport(await makeProgram({ name: 'V default', on: true }), { name: 'Discipline', loadUsed: 'Load Used', rpe: 'Last Set RPE' })
    expect(cells.filter((t) => t === 'Velocity')).toHaveLength(7 * DATES.length)
    expect(cells.filter((t) => t === '0.50 · VL 20%')).toHaveLength(DATES.length)
  })

  it('Minimalistic look: gets the Velocity column too', async () => {
    const cells = await fillAndImport(await makeProgram({ name: 'V minimal', on: true, builtin: 'minimal' }), { name: 'Exercise', loadUsed: 'Load', rpe: 'RPE' })
    expect(cells.filter((t) => t === 'Velocity')).toHaveLength(7 * DATES.length)
  })

  it("a coach's style with an Intensity column: the target after the Intensity text", async () => {
    const cells = await fillAndImport(await makeProgram({ name: 'V after intensity', on: true, layout: WITH_INTENSITY }), { name: 'Movement', loadUsed: 'Load Used', rpe: 'Last Set RPE' })
    expect(cells).not.toContain('Velocity')
    expect(cells.filter((t) => t === 'RPE 8 · 0.50 · VL 20%')).toHaveLength(DATES.length)
    expect(cells.filter((t) => t === 'RPE 7')).toHaveLength(DATES.length)
  })

  it("a coach's style with its own velocity column: the target goes there", async () => {
    const cells = await fillAndImport(await makeProgram({ name: 'V own column', on: true, layout: WITH_VELOCITY }), { name: 'Movement', loadUsed: 'Load Used', rpe: 'Last Set RPE' })
    expect(cells.filter((t) => t === 'Bar speed')).toHaveLength(7 * DATES.length)
    expect(cells.filter((t) => t === '0.50 · VL 20%')).toHaveLength(DATES.length)
    expect(cells).not.toContain('RPE 8 · 0.50 · VL 20%')
  })

  it('Modern look: the target on the card after the intensity', async () => {
    const cells = allText(await sheetOf((await buildProgramWorkbook(await makeProgram({ name: 'V modern', on: true, builtin: 'modern' }))).buffer))
    expect(cells.some((t) => t.includes('RPE 8   ·   0.50 · VL 20%'))).toBe(true)
  })
})

describe('Velocity column off — the sheet is what it always was', () => {
  for (const look of [
    { name: "CoachBoard's own look", builtin: 'coachboard', layout: undefined },
    { name: 'Minimalistic', builtin: 'minimal', layout: undefined },
    { name: 'Modern', builtin: 'modern', layout: undefined },
    { name: "a coach's style with an Intensity column", builtin: 'coachboard', layout: WITH_INTENSITY },
  ]) {
    it(`${look.name}: no Velocity column and no target anywhere, though one is written`, async () => {
      const id = await makeProgram({ name: `V off ${look.name}`, on: false, builtin: look.builtin, layout: look.layout })
      const cells = allText(await sheetOf((await buildProgramWorkbook(id)).buffer))
      expect(cells).not.toContain('Velocity')
      expect(cells.some((t) => t.includes('0.50'))).toBe(false)
    })
  }
})

describe('reading a coach sheet', () => {
  it('a velocity / speed column is the target; a measured one is not', () => {
    const header = (cells: string[]) => resolveHeaderRow(cells).mapping.velocity
    expect(header(['Exercise', 'Sets', 'Reps', 'Load', 'Velocity'])).toBe(5)
    expect(header(['Exercise', 'Sets', 'Reps', 'Target speed', 'RPE'])).toBe(4)
    expect(header(['Övning', 'Serier', 'Reps', 'Hastighet'])).toBe(4)
    expect(header(['Exercise', 'Sets', 'Reps', 'Actual speed'])).toBeNull()
    // Never counts toward picking the header row.
    expect(resolveHeaderRow(['Velocity']).matchCount).toBe(0)
  })
})
