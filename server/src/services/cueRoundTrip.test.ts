import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import type { ExportLayoutTemplate } from 'coachboard-shared'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import { createProgram, setProgramDuration, createWorkout, createExercise } from './programService.js'
import { buildProgramWorkbook } from './programExport.js'
import { parseImportFile } from './importService.js'

// ---------------------------------------------------------------------------
// The cue column (Notes) through a full export → athlete fills it in → import.
//
// The column list decides where in each week block the results sit, and the
// importer reads them back by the same list. A Notes column the two sides
// disagreed on would put every result after it in the wrong cell, so this runs
// the real exporter and the real importer, three weeks deep (the offset grows
// with each week), for every grid look — and checks that with the switch off
// the sheet carries no trace of the cues at all.
// ---------------------------------------------------------------------------

const PLAN = [
  { name: 'Squat', sets: '3', reps: '5', notes: 'pause 2 s at the bottom' },
  { name: 'Bench Press', sets: '3', reps: '8', notes: null },
  { name: 'Barbell Row', sets: '3', reps: '10', notes: 'strict, no hip drive' },
]
const DATES = ['2026-06-08', '2026-06-15', '2026-06-22']

const COACH_STYLE: ExportLayoutTemplate = {
  version: 1,
  orientation: 'horizontal',
  columns: [
    { key: 'name', label: 'Movement' },
    { key: 'sets', label: 'Sets' },
    { key: 'reps', label: 'Reps' },
    { key: 'load_used', label: 'Load Used' },
    { key: 'rpe', label: 'Last Set RPE' },
  ],
  dayLabels: { style: 'weekday', language: 'en' },
  rpeNotation: 'plain',
  colors: { weekBanner: null, dayHeader: null, columnHeader: null, trackingHeader: null, body: null },
  fonts: { headerBold: true, headerItalic: true, nameBold: true },
}

let athleteId: string
beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Cue Athlete' })).id
})

async function makeProgram(opts: { name: string; cues: boolean; builtin?: string; layout?: ExportLayoutTemplate }) {
  const columns = ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe', ...(opts.cues ? ['notes'] : [])]
  const program = await createProgram({
    athlete_id: athleteId, name: opts.name, enabled_columns: columns, builtin_template: opts.builtin ?? 'coachboard',
  })
  await setProgramDuration(program.id, DATES[0], 3)
  if (opts.layout) {
    await getDb().updateTable('programs').set({ export_layout: JSON.stringify(opts.layout) }).where('id', '=', program.id).execute()
  }
  for (const date of DATES) {
    const w = await createWorkout({ program_id: program.id, name: 'Monday', scheduled_date: date })
    for (const [i, lift] of PLAN.entries()) {
      await createExercise({ workout_id: w.id, name: lift.name, sets: lift.sets, reps: lift.reps, notes: lift.notes, order_index: i })
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

/**
 * Fill Load Used and RPE under their headers, as an athlete does, and give
 * each lift a distinct load per week so a value landing on the wrong exercise
 * or week shows up.
 */
async function fill(buffer: Buffer, labels: { name: string; loadUsed: string; rpe: string }) {
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
        const cell = text(ws, body, nameCol)
        // The name cell may carry the cue after it in a coach's style.
        const lift = PLAN.findIndex((l) => cell === l.name || cell.startsWith(`${l.name} - `))
        if (lift === -1) continue
        const load = 100 + week * 10 + lift
        ws.getCell(body, loadCols[week]).value = load
        ws.getCell(body, rpeCols[week]).value = 8
        written.set(`${week}|${PLAN[lift].name}`, load)
      }
    }
  }
  return { buffer: Buffer.from((await ws.workbook.xlsx.writeBuffer()) as ArrayBuffer), written }
}

async function expectCleanRoundTrip(programId: string, labels: { name: string; loadUsed: string; rpe: string }) {
  const { buffer } = await buildProgramWorkbook(programId)
  const { buffer: filled, written } = await fill(buffer, labels)
  expect(written.size).toBe(PLAN.length * DATES.length)
  const result = await parseImportFile(filled, programId)
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
  expect(result.matched.length).toBe(written.size)
  for (const m of result.matched) {
    expect(m.load_used, `${m.exerciseName} week ${m.weekIndex + 1}`).toBe(String(written.get(`${m.weekIndex}|${m.exerciseName}`)))
    expect(m.rpe).toBe('8')
  }
  return buffer
}

describe('cue column on — export and import still line up', () => {
  it("CoachBoard's own look: a Notes column at the end of each week, results read back right", async () => {
    const id = await makeProgram({ name: 'Cues default', cues: true })
    const ws = await sheetOf(await expectCleanRoundTrip(id, { name: 'Discipline', loadUsed: 'Load Used', rpe: 'Last Set RPE' }))
    const cells = allText(ws)
    // A Notes header in every week block, on each of the 7 day header rows.
    expect(cells.filter((t) => t === 'Notes')).toHaveLength(7 * 3)
    expect(cells.filter((t) => t === 'pause 2 s at the bottom')).toHaveLength(3)
    expect(cells).toContain('strict, no hip drive')
  })

  it('Minimalistic look: gets the Notes column too, results read back right', async () => {
    const id = await makeProgram({ name: 'Cues minimal', cues: true, builtin: 'minimal' })
    const ws = await sheetOf(await expectCleanRoundTrip(id, { name: 'Exercise', loadUsed: 'Load', rpe: 'RPE' }))
    expect(allText(ws).filter((t) => t === 'Notes')).toHaveLength(7 * 3)
  })

  it("a coach's own style: no new column, the cue after the name, results read back right", async () => {
    const id = await makeProgram({ name: 'Cues coach style', cues: true, layout: COACH_STYLE })
    const ws = await sheetOf(await expectCleanRoundTrip(id, { name: 'Movement', loadUsed: 'Load Used', rpe: 'Last Set RPE' }))
    const cells = allText(ws)
    expect(cells).not.toContain('Notes')
    expect(cells.filter((t) => t === 'Squat - pause 2 s at the bottom')).toHaveLength(3)
    // No cue, no suffix.
    expect(cells.filter((t) => t === 'Bench Press')).toHaveLength(3)
  })
})

describe('cue column off — the sheet is what it always was', () => {
  for (const look of [
    { name: "CoachBoard's own look", builtin: 'coachboard' as const, layout: undefined },
    { name: 'Minimalistic', builtin: 'minimal' as const, layout: undefined },
    { name: "a coach's own style", builtin: 'coachboard' as const, layout: COACH_STYLE },
  ]) {
    it(`${look.name}: no Notes column and no cue anywhere, though cues are written`, async () => {
      const id = await makeProgram({ name: `Off ${look.name}`, cues: false, builtin: look.builtin, layout: look.layout })
      const ws = await sheetOf((await buildProgramWorkbook(id)).buffer)
      const cells = allText(ws)
      expect(cells).not.toContain('Notes')
      expect(cells.some((t) => t.includes('pause 2 s'))).toBe(false)
    })
  }

  it('a program with no column choice at all (enabled_columns null) has no Notes column', async () => {
    const p = await createProgram({ athlete_id: athleteId, name: 'Never chosen' })
    await setProgramDuration(p.id, DATES[0], 1)
    const w = await createWorkout({ program_id: p.id, name: 'Monday', scheduled_date: DATES[0] })
    await createExercise({ workout_id: w.id, name: 'Squat', notes: 'pause 2 s', order_index: 0 })
    const cells = allText(await sheetOf((await buildProgramWorkbook(p.id)).buffer))
    expect(cells).not.toContain('Notes')
    expect(cells.some((t) => t.includes('pause 2 s'))).toBe(false)
    // …and still has every column it had before.
    for (const label of ['Rest Time (mins)', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']) {
      expect(cells).toContain(label)
    }
  })
})

describe('Modern look', () => {
  it('puts the cue on the card when on, and leaves it off when off', async () => {
    const on = await makeProgram({ name: 'Modern on', cues: true, builtin: 'modern' })
    const off = await makeProgram({ name: 'Modern off', cues: false, builtin: 'modern' })
    const onCells = allText(await sheetOf((await buildProgramWorkbook(on)).buffer))
    const offCells = allText(await sheetOf((await buildProgramWorkbook(off)).buffer))
    expect(onCells.some((t) => t.endsWith('pause 2 s at the bottom'))).toBe(true)
    expect(offCells.some((t) => t.includes('pause 2 s'))).toBe(false)
  })
})
