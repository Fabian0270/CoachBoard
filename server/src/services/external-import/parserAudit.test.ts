import { describe, it, expect, beforeAll } from 'vitest'
import ExcelJS from 'exceljs'
import { parseExternalFile } from './parseExternalFile.js'
import { renderProgramWorkbook } from '../exportService.js'
import { initializeDatabase, getDb } from '../../db.js'
import { createAthlete } from '../athleteService.js'
import { commitExternalProgram } from './commit.js'
import type { ExternalExerciseRow } from 'coachboard-shared'

// Import cases from the 2026-11 audit, each one a sheet a coach can plausibly
// hand the importer that it used to read wrong without saying so.

async function sheet(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  rows.forEach((r, i) => r.forEach((v, j) => {
    if (v !== null) ws.getCell(i + 1, j + 1).value = v as ExcelJS.CellValue
  }))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('stacked (vertical) sheets', () => {
  it('places weekday sections on their weekday', async () => {
    // Monday/Wednesday/Friday used to come in as days 0, 1, 2 — and land on
    // Monday, Tuesday, Wednesday.
    const p = await parseExternalFile(await sheet([
      ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
      ['Monday'], ['Squat', 3, 5, 100, 8],
      ['Wednesday'], ['Bench', 3, 5, 80, 8],
      ['Friday'], ['Deadlift', 3, 3, 150, 8],
    ]))
    expect(p.exercises.map((e) => e.dayIndex)).toEqual([0, 2, 4])
  })

  it('keeps rows with unusual sets, and recovers a range Excel turned into a date', async () => {
    const p = await parseExternalFile(await sheet([
      ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
      ['Squat', 3, 5, 100, 8],
      ['Plank', '3x', 30, null, null],
      ['Pause Squat', new Date(Date.UTC(2026, 2, 4)), 5, 90, 7], // "3-4", mangled by Excel
    ]))
    expect(p.exercises.map((e) => [e.name, e.sets])).toEqual([
      ['Squat', '3'], ['Plank', '3x'], ['Pause Squat', '3-4'],
    ])
    expect(p.warnings.map((w) => w.message).join(' ')).toMatch(/sets "3x" kept as written/)
  })

  it('reads "@8" and keeps an RPE range', async () => {
    const p = await parseExternalFile(await sheet([
      ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
      ['Bench', 3, 5, 80, '@8'],
      ['Push Press', 3, 5, 50, '8-9'],
      ['Row', 3, 8, 60, '@7,5'],
    ]))
    expect(p.exercises.map((e) => e.intensity)).toEqual(['@8', '@8-9', '@7.5'])
  })

  it('turns an RIR range into the matching RPE range', async () => {
    const p = await parseExternalFile(await sheet([
      ['Exercise', 'Sets', 'Reps', 'Load', 'RIR'],
      ['Squat', 3, 5, 100, '1-2'],
    ]))
    expect(p.exercises[0].intensity).toBe('@8-9')
  })

  it('warns when a load is in pounds', async () => {
    const p = await parseExternalFile(await sheet([
      ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
      ['Bench', 3, 5, '225 lbs', 8],
    ]))
    expect(p.exercises[0].loadCap).toBe(225)
    expect(p.warnings.map((w) => w.message).join(' ')).toMatch(/pounds/)
  })
})

describe('side-by-side (horizontal) sheets', () => {
  /** The app's own horizontal export of a 3-week, 2-exercise program, with banners reworded. */
  async function exportWithBanners(rename: (s: string) => string): Promise<Buffer> {
    const program = { name: 'P', start_date: '2026-01-05', end_date: '2026-01-25', enabled_columns: null, export_layout: null }
    const workouts = [0, 7, 14].map((d, i) => ({
      id: `w${i}`, scheduled_date: new Date(Date.UTC(2026, 0, 5 + d)).toISOString().slice(0, 10),
    }))
    const exercises = workouts.flatMap((w) => [0, 1].map((i) => ({
      name: i ? 'Bench' : 'Squat', sets: '3', reps: '5', weight: 100, rest_time: null,
      intensity: null, load_used: '100', rpe: '8', group_id: null, order_index: i, workout_id: w.id,
    })))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await renderProgramWorkbook(program, workouts, exercises)) as unknown as ArrayBuffer)
    wb.worksheets[0].eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === 'string') cell.value = rename(cell.value)
    }))
    return Buffer.from(await wb.xlsx.writeBuffer())
  }

  it.each([
    ['Vecka N', (s: string) => s.replace(/^Week (\d+)$/, 'Vecka $1')],
    ['Wk N', (s: string) => s.replace(/^Week (\d+)$/, 'Wk $1')],
    ['Week N – Volume', (s: string) => s.replace(/^Week (\d+)$/, 'Week $1 – Volume')],
  ])('recognises "%s" banners', async (_label, rename) => {
    // These used to fall through to the stacked parser: 2 of 6 exercises, 1 of 3 weeks.
    const p = await parseExternalFile(await exportWithBanners(rename))
    expect(p.layout).toBe('horizontal')
    expect(p.weeks).toBe(3)
    expect(p.exerciseCount).toBe(6)
  })

  it('does not read an exercise named like a weekday as a new day', async () => {
    // Column 1 holds the day labels. A note in column 1 that starts with "fre"
    // (Fredag) — here "French Press" — used to open a new Friday section and
    // skip its row, so Curl vanished and nothing after it was Monday any more.
    const withHeader = await parseExternalFile(await sheet([
      [null, null, 'Week 1', null, 'Week 2', null],
      ['Monday', 'Exercise', 'Sets', 'Reps', 'Sets', 'Reps'],
      [null, 'Squat', 3, 5, 3, 5],
      [null, 'French Press', 3, 10, 3, 10],
      ['French Press', 'Curl', 3, 12, 3, 12],
    ]))
    expect(withHeader.exercises.every((e) => e.dayIndex === 0)).toBe(true)
    expect(withHeader.exercises.map((e) => e.name)).toContain('Curl')
  })
})

describe('committing an imported program', () => {
  let athleteId = ''
  beforeAll(async () => {
    await initializeDatabase(':memory:')
    athleteId = (await createAthlete({ name: 'Lifter' })).id
  })

  const row = (weekIndex: number, dayIndex: number, name: string): ExternalExerciseRow => ({
    weekIndex, dayIndex, weekLabel: `Week ${weekIndex + 1}`, dayLabel: `Day ${dayIndex + 1}`,
    name, sets: '3', reps: '5', load: null, rpe: null, sheetRow: 1,
  })

  const commit = (rows: ExternalExerciseRow[], weeks: number) =>
    commitExternalProgram(rows, {
      athleteId, name: 'Imported', status: 'active', startDate: '2026-01-05', weeks,
    })

  it('rolls an eighth day section into the next week instead of stacking it on Sunday', async () => {
    const rows = Array.from({ length: 9 }, (_, d) => row(0, d, `Ex day ${d + 1}`))
    const { programId } = await commit(rows, 1)
    const workouts = await getDb().selectFrom('workouts').select('scheduled_date').where('program_id', '=', programId).execute()
    const dates = workouts.map((w) => w.scheduled_date)
    expect(new Set(dates).size).toBe(dates.length) // one workout per date, none hidden
    const program = await getDb().selectFrom('programs').selectAll().where('id', '=', programId).executeTakeFirstOrThrow()
    expect(program.end_date! >= '2026-01-13').toBe(true) // covers the rolled-over days
  })

  it('makes the program long enough for its last week, even with an empty week before it', async () => {
    // Weeks 1 and 3 have data, week 2 none: two weeks "with data", but the
    // program has to reach the end of week 3.
    const { programId } = await commit([row(0, 0, 'A'), row(2, 0, 'B')], 2)
    const program = await getDb().selectFrom('programs').selectAll().where('id', '=', programId).executeTakeFirstOrThrow()
    expect(program.end_date).toBe('2026-01-25')
  })
})
