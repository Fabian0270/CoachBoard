import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import { findProgramById } from './programService.js'
import { getProgramReport } from './analysisService.js'
import { parseExternalFile, commitExternalProgram } from './externalImportService.js'

type Cell = string | number | null
async function buildSheet(rows: Cell[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach((row, r) => {
    row.forEach((val, c) => {
      if (val !== null && val !== undefined && val !== '') ws.getCell(r + 1, c + 1).value = val
    })
  })
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

const HEADER = ['Exercise', 'Sets', 'Reps', 'Load', 'RPE']

// A 2-week × 2-day program with a multi-set Squat on week 1 day 1.
const GRID: Cell[][] = [
  HEADER,
  ['Week 1'],
  ['Day 1'],
  ['Squat', 3, 5, 100, 8],
  ['Squat', 3, 5, 100, 8],
  ['Bench Press', 3, 8, 60, 7],
  ['Day 2'],
  ['Deadlift', 1, 5, 140, 9],
  ['Week 2'],
  ['Day 1'],
  ['Squat', 3, 5, 105, 8],
  ['Day 2'],
  ['Deadlift', 1, 5, 145, 9],
]

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const athlete = await createAthlete({ name: 'External Import Athlete' })
  athleteId = athlete.id
})

async function commitGrid(grid: Cell[][], status = 'active', startDate = '2026-06-15') {
  const buf = await buildSheet(grid)
  const preview = await parseExternalFile(buf)
  return commitExternalProgram(preview.exercises, {
    athleteId, name: 'Imported Block', status, startDate, weeks: preview.weeks,
  })
}

describe('commitExternalProgram', () => {
  it('creates a program with one workout per (week,day) block in date order', async () => {
    const { programId } = await commitGrid(GRID)
    const program = await findProgramById(programId)
    expect(program).toBeTruthy()
    expect(program!.workouts.map((w) => w.scheduled_date)).toEqual([
      '2026-06-15', '2026-06-16', '2026-06-22', '2026-06-23',
    ])
  })

  it('preserves exercise order within a day', async () => {
    const { programId } = await commitGrid(GRID)
    const program = await findProgramById(programId)
    const day1 = program!.workouts.find((w) => w.scheduled_date === '2026-06-15')!
    expect(day1.exercises.map((e) => e.name)).toEqual(['Squat', 'Squat', 'Bench Press'])
    expect(day1.exercises.map((e) => e.order_index)).toEqual([0, 1, 2])
  })

  it('places week 2 day 1 exactly 7 days after week 1 day 1', async () => {
    const { programId } = await commitGrid(GRID)
    const program = await findProgramById(programId)
    const dates = program!.workouts.map((w) => w.scheduled_date).sort()
    expect(dates[0]).toBe('2026-06-15')
    expect(dates[2]).toBe('2026-06-22') // week 2 day 1
  })

  it('groups consecutive same-name rows and leaves distinct names ungrouped', async () => {
    const { programId } = await commitGrid(GRID)
    const program = await findProgramById(programId)
    const day1 = program!.workouts.find((w) => w.scheduled_date === '2026-06-15')!
    const [squatA, squatB, bench] = day1.exercises
    expect(squatA.group_id).not.toBeNull()
    expect(squatA.group_id).toBe(squatB.group_id)
    expect(bench.group_id).toBeNull()
  })

  it('maps load/rpe and persists status, name and athlete', async () => {
    const { programId } = await commitGrid(GRID, 'completed')
    const program = await findProgramById(programId)
    expect(program!.status).toBe('completed')
    expect(program!.name).toBe('Imported Block')
    expect(program!.athlete_id).toBe(athleteId)
    const squat = program!.workouts[0].exercises[0]
    expect(squat.load_used).toBe('100')
    expect(squat.rpe).toBe('8')
  })

  it('produces an analysis report for a completed import', async () => {
    const { programId } = await commitGrid(GRID, 'completed')
    const report = await getProgramReport(programId)
    expect(report).toBeTruthy()
    expect(report!.e1rmTrends.length).toBeGreaterThan(0)
    expect(report!.e1rmTrends.some((t) => t.latestE1RM !== null)).toBe(true)
    // Every imported row carries a load → the program reads as fully completed.
    expect(report!.completionRate).toBe(1)
    expect(report!.exercisesCompleted).toBe(report!.exercisesTotal)
  })

  it('persists the chosen training focus on commit', async () => {
    const buf = await buildSheet(GRID)
    const preview = await parseExternalFile(buf)
    const { programId } = await commitExternalProgram(preview.exercises, {
      athleteId, name: 'Focused Block', status: 'completed', startDate: '2026-06-15',
      weeks: preview.weeks, focus: 'strength',
    })
    const program = await findProgramById(programId)
    expect(program!.focus).toBe('strength')
  })

  it('commits an archived program with no start date, placing days in order', async () => {
    const buf = await buildSheet(GRID)
    const preview = await parseExternalFile(buf)
    const { programId } = await commitExternalProgram(preview.exercises, {
      athleteId, name: 'Old Block', status: 'archived', weeks: preview.weeks,
    })
    const program = await findProgramById(programId)
    expect(program!.status).toBe('archived')
    expect(program!.start_date).toBeTruthy() // server filled a synthetic start date
    expect(program!.workouts.length).toBe(4)

    // Days still ordered: week 2 day 1 is 7 days after week 1 day 1.
    const dates = program!.workouts.map((w) => w.scheduled_date!).sort()
    const first = new Date(dates[0])
    const weekTwo = new Date(dates[2])
    const diffDays = Math.round((weekTwo.getTime() - first.getTime()) / 86400000)
    expect(diffDays).toBe(7)
  })

  it('rejects a commit for a non-existent athlete', async () => {
    const buf = await buildSheet(GRID)
    const preview = await parseExternalFile(buf)
    await expect(
      commitExternalProgram(preview.exercises, {
        athleteId: '00000000-0000-0000-0000-000000000000',
        name: 'X', status: 'active', startDate: '2026-06-15', weeks: preview.weeks,
      }),
    ).rejects.toThrow(/not found/i)
  })
})

// --- Horizontal (CoachBoard-export) layout: weeks as column blocks ---
const BLOCK_COLS = ['Discipline', 'Rest Time(mins)', 'Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
const BLOCK = BLOCK_COLS.length
const weekStart = (w: number) => 2 + w * (BLOCK + 1)

// 3-week program: Monday has Squat, Wednesday has Bench. Distinct loads per week.
async function buildHorizontalGrid(): Promise<Cell[][]> {
  const grid: Cell[][] = []
  const place = (row: Cell[], w: number, vals: Cell[]) => {
    const s = weekStart(w) - 1
    vals.forEach((v, off) => { if (v !== null && v !== undefined && v !== '') row[s + off] = v })
  }
  const banner: Cell[] = []
  for (let w = 0; w < 3; w++) banner[weekStart(w) - 1] = `Week ${w + 1}`
  grid.push(banner)

  const days: Array<{ day: string; name: string; loads: number[] }> = [
    { day: 'Monday', name: 'Squat', loads: [150, 155, 160] },
    { day: 'Wednesday', name: 'Bench', loads: [100, 102, 105] },
  ]
  for (const d of days) {
    const header: Cell[] = []
    header[0] = d.day
    for (let w = 0; w < 3; w++) place(header, w, BLOCK_COLS)
    grid.push(header)
    const row: Cell[] = []
    for (let w = 0; w < 3; w++) place(row, w, [d.name, '', 3, 5, 'RPE 8', d.loads[w], d.loads[w], 8])
    grid.push(row)
    grid.push([])
  }
  return grid
}

describe('commitExternalProgram (horizontal layout)', () => {
  it('commits a CoachBoard-style export across weeks with intensity/weight preserved', async () => {
    const buf = await buildSheet(await buildHorizontalGrid())
    const preview = await parseExternalFile(buf)
    expect(preview.layout).toBe('horizontal')

    const { programId } = await commitExternalProgram(preview.exercises, {
      athleteId, name: 'Imported CB Block', status: 'completed', startDate: '2026-06-15', weeks: preview.weeks,
    })
    const program = await findProgramById(programId)

    // 3 weeks × 2 days = 6 workouts; week 2 Monday is 7 days after week 1 Monday.
    expect(program!.workouts.length).toBe(6)
    const mondays = program!.workouts
      .flatMap((w) => w.exercises.map((e) => ({ date: w.scheduled_date!, name: e.name })))
      .filter((x) => x.name === 'Squat')
      .map((x) => x.date)
      .sort()
    expect(Math.round((new Date(mondays[1]).getTime() - new Date(mondays[0]).getTime()) / 86400000)).toBe(7)

    // Field mapping: prescribed intensity + load cap and actual load used persisted.
    const firstSquat = program!.workouts
      .flatMap((w) => w.exercises)
      .find((e) => e.name === 'Squat' && e.load_used === '150')!
    expect(firstSquat.intensity).toBe('RPE 8')
    expect(firstSquat.weight).toBe(150)
    expect(firstSquat.rpe).toBe('8')

    // Completed import → analysis report works.
    const report = await getProgramReport(programId)
    expect(report!.e1rmTrends.length).toBeGreaterThan(0)
  })
})
