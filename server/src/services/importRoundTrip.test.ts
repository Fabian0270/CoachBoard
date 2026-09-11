import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import type { ExportLayoutTemplate } from 'coachboard-shared'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  createProgram,
  setProgramDuration,
  createWorkout,
  createExercise,
} from './programService.js'
import { buildProgramWorkbook } from './programExport.js'
import { parseImportFile } from './importService.js'

// ---------------------------------------------------------------------------
// TRUE export→import round trip.
//
// importService.test.ts builds its fixture sheet by re-implementing the
// exporter's layout maths, so it can only ever prove the importer agrees with
// itself. This suite instead renders through the real production entry point
// (buildProgramWorkbook — the same call the download and email routes make),
// fills the tracking columns the way an athlete would, and imports that.
//
// The sheet is filled STRUCTURALLY: find the header cells by their label text,
// then write beneath them. Nothing here recomputes a column offset, so a
// disagreement between the two sides shows up as a failure rather than being
// baked into the fixture.
// ---------------------------------------------------------------------------

/** A captured coach style: 5 columns and the coach's own header wording. */
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
  colors: {
    weekBanner: null, dayHeader: null, columnHeader: null, trackingHeader: null, body: null,
  },
  fonts: { headerBold: true, headerItalic: true, nameBold: true },
}

/** The lifts each week, in the order the day editor holds them. */
const WEEK_PLAN = [
  { name: 'Squat', sets: '3', reps: '5' },
  { name: 'Bench Press', sets: '3', reps: '8' },
  { name: 'Barbell Row', sets: '3', reps: '10' },
]

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Round Trip Athlete' })).id
})

/**
 * A 3-week program, three lifts every Monday. Three weeks matters: the column
 * stride is multiplied by the week index, so a geometry disagreement is
 * invisible in week 1 and grows from there.
 */
async function makeProgram(opts: {
  name: string
  builtin_template?: string
  export_layout?: ExportLayoutTemplate
}): Promise<string> {
  const program = await createProgram({
    athlete_id: athleteId,
    name: opts.name,
    enabled_columns: ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'],
    builtin_template: opts.builtin_template ?? 'coachboard',
  })
  await setProgramDuration(program.id, '2026-06-08', 3) // Mondays: 06-08, 06-15, 06-22

  if (opts.export_layout) {
    await getDb()
      .updateTable('programs')
      .set({ export_layout: JSON.stringify(opts.export_layout) })
      .where('id', '=', program.id)
      .execute()
  }

  for (const date of ['2026-06-08', '2026-06-15', '2026-06-22']) {
    const workout = await createWorkout({
      program_id: program.id, name: 'Monday', scheduled_date: date,
    })
    for (const [i, lift] of WEEK_PLAN.entries()) {
      await createExercise({
        workout_id: workout.id, name: lift.name, sets: lift.sets, reps: lift.reps, order_index: i,
      })
    }
  }
  return program.id
}

/**
 * Fill in Load Used and Last Set RPE the way an athlete does: read the sheet,
 * find the columns by their header text, write underneath them.
 *
 * Returns the values written, keyed "<week>|<exercise name>", so the assertions
 * compare against what is actually in the file rather than an assumed position.
 */
async function fillTrackingColumns(
  buffer: Buffer,
  labels: { name: string; loadUsed: string; rpe: string },
): Promise<{ buffer: Buffer; written: Map<string, { load: number; rpe: number }> }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  const written = new Map<string, { load: number; rpe: number }>()

  const textAt = (r: number, c: number): string =>
    ws.getCell(r, c).value === null || ws.getCell(r, c).value === undefined
      ? '' : String(ws.getCell(r, c).value).trim()

  const colsWithLabel = (row: number, label: string): number[] => {
    const found: number[] = []
    for (let c = 1; c <= ws.columnCount; c++) if (textAt(row, c) === label) found.push(c)
    return found
  }

  for (let row = 1; row <= ws.rowCount; row++) {
    const nameCols = colsWithLabel(row, labels.name)
    const loadCols = colsWithLabel(row, labels.loadUsed)
    const rpeCols = colsWithLabel(row, labels.rpe)
    // A day's header row carries every label once per week block.
    if (nameCols.length === 0 || nameCols.length !== loadCols.length) continue

    // Body rows run until the next header row or the blank separator.
    for (let body = row + 1; body <= ws.rowCount; body++) {
      if (colsWithLabel(body, labels.name).length > 0) break
      const anyName = nameCols.some((c) => textAt(body, c) !== '')
      if (!anyName) break

      for (const [weekIndex, nameCol] of nameCols.entries()) {
        const exerciseName = textAt(body, nameCol)
        if (!exerciseName) continue
        const load = 100 + weekIndex * 10 + WEEK_PLAN.findIndex((l) => l.name === exerciseName)
        const rpe = 8
        ws.getCell(body, loadCols[weekIndex]).value = load
        ws.getCell(body, rpeCols[weekIndex]).value = rpe
        written.set(`${weekIndex}|${exerciseName}`, { load, rpe })
      }
    }
  }

  const out = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  return { buffer: out, written }
}

/** Every lift, every week, read back onto the right exercise with no warnings. */
async function expectCleanRoundTrip(programId: string, labels: Parameters<typeof fillTrackingColumns>[1]) {
  const { buffer } = await buildProgramWorkbook(programId)
  const { buffer: filled, written } = await fillTrackingColumns(buffer, labels)

  expect(written.size).toBe(WEEK_PLAN.length * 3) // sanity: the fill found the sheet

  const result = await parseImportFile(filled, programId)

  expect(result.warnings).toEqual([])
  expect(result.matched.length).toBe(written.size)

  for (const match of result.matched) {
    const expected = written.get(`${match.weekIndex}|${match.exerciseName}`)
    expect(expected, `no value written for ${match.exerciseName} week ${match.weekIndex + 1}`).toBeDefined()
    expect(match.load_used).toBe(String(expected!.load))
    expect(match.rpe).toBe(String(expected!.rpe))
  }
}

describe('export → import round trip (real exporter)', () => {
  it('default CoachBoard look reads back onto the right exercises', async () => {
    const programId = await makeProgram({ name: 'Default Look' })
    await expectCleanRoundTrip(programId, {
      name: 'Discipline', loadUsed: 'Load Used', rpe: 'Last Set RPE',
    })
  })

  it("a captured coach style reads back onto the right exercises", async () => {
    const programId = await makeProgram({ name: 'Coach Style', export_layout: COACH_STYLE })
    await expectCleanRoundTrip(programId, {
      name: 'Movement', loadUsed: 'Load Used', rpe: 'Last Set RPE',
    })
  })

  it('the Minimalistic built-in reads back onto the right exercises', async () => {
    const programId = await makeProgram({ name: 'Minimal Look', builtin_template: 'minimal' })
    await expectCleanRoundTrip(programId, {
      name: 'Exercise', loadUsed: 'Load', rpe: 'RPE',
    })
  })

  it('reads a sheet that shares one name column across every week', async () => {
    // The shape a real returned sheet had: a title block above the data, the
    // exercise name written ONCE on the left instead of repeated per week, and
    // six columns per week rather than eight. No offset replay can follow that —
    // the columns have to be found by their headers.
    const programId = await makeProgram({ name: 'Shared Name Column' })

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    const WEEK_COLS = [4, 11, 18] // three weeks, stride 7, no name column inside
    const HEADER_ROW = 9          // data starts well below row 1

    ws.getCell(HEADER_ROW, 1).value = 'Monday'
    ws.getCell(HEADER_ROW, 2).value = 'Discipline'
    ws.getCell(HEADER_ROW, 3).value = 'Rest Time(mins)'
    for (const base of WEEK_COLS) {
      const labels = ['Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
      labels.forEach((label, i) => { ws.getCell(HEADER_ROW, base + i).value = label })
    }

    const expected = new Map<string, { load: number; rpe: number }>()
    WEEK_PLAN.forEach((lift, r) => {
      const row = HEADER_ROW + 1 + r
      ws.getCell(row, 2).value = lift.name          // the single shared name cell
      WEEK_COLS.forEach((base, weekIndex) => {
        const load = 200 + weekIndex * 10 + r
        ws.getCell(row, base + 4).value = load      // Load Used
        ws.getCell(row, base + 5).value = 8         // Last Set RPE
        expected.set(`${weekIndex}|${lift.name}`, { load, rpe: 8 })
      })
    })

    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const result = await parseImportFile(buf, programId)

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.matched.length).toBe(WEEK_PLAN.length * WEEK_COLS.length)
    for (const match of result.matched) {
      const want = expected.get(`${match.weekIndex}|${match.exerciseName}`)
      expect(want).toBeDefined()
      expect(match.load_used).toBe(String(want!.load))
      expect(match.rpe).toBe('8')
    }
  })

  it('a vertical coach style is refused rather than read as a grid', async () => {
    const programId = await makeProgram({
      name: 'Vertical Style',
      export_layout: { ...COACH_STYLE, orientation: 'vertical' },
    })
    const { buffer } = await buildProgramWorkbook(programId)

    const result = await parseImportFile(buffer, programId)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('stacks weeks vertically')
    expect(result.matched).toEqual([])
    // Refused, not silently read as week 1 — a vertical sheet repeats one column
    // set down the page, so every week would otherwise collapse onto the first.
  })

  it('the Modern layout is refused rather than read as a grid', async () => {
    const programId = await makeProgram({ name: 'Modern Look', builtin_template: 'modern' })
    const { buffer } = await buildProgramWorkbook(programId)

    const result = await parseImportFile(buffer, programId)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Modern layout')
    expect(result.matched).toEqual([])
  })

  it("refuses a sheet exported from a different program instead of importing it", async () => {
    const mine = await makeProgram({ name: 'Mine' })
    const theirs = await makeProgram({ name: 'Theirs' })
    // Rename every lift in the other program so the sheets can't line up.
    const otherWorkouts = await getDb()
      .selectFrom('workouts').select(['id']).where('program_id', '=', theirs).execute()
    for (const w of otherWorkouts) {
      await getDb().updateTable('exercises')
        .set({ name: 'Leg Press' }).where('workout_id', '=', w.id).execute()
    }

    const { buffer } = await buildProgramWorkbook(theirs)
    const { buffer: filled } = await fillTrackingColumns(buffer, {
      name: 'Discipline', loadUsed: 'Load Used', rpe: 'Last Set RPE',
    })

    const result = await parseImportFile(filled, mine)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("doesn't line up")
    expect(result.matched).toEqual([])
  })
})
