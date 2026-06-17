import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseExternalFile } from './externalImportService.js'

// ---------------------------------------------------------------------------
// Helper — build an xlsx buffer from a 2-D grid of cell values.
// Only non-empty cells are written. Optional A1-style merge ranges are applied
// after population (set the master cell value in the grid, leave slaves null).
// ---------------------------------------------------------------------------
type Cell = string | number | null
async function buildSheet(rows: Cell[][], merges: string[] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach((row, r) => {
    row.forEach((val, c) => {
      if (val !== null && val !== undefined && val !== '') {
        ws.getCell(r + 1, c + 1).value = val
      }
    })
  })
  for (const range of merges) ws.mergeCells(range)
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

const HEADER = ['Exercise', 'Sets', 'Reps', 'Load', 'RPE']

describe('parseExternalFile', () => {
  it('parses a clean 2-week × 2-day file', async () => {
    const buf = await buildSheet([
      HEADER,
      ['Week 1'],
      ['Day 1'],
      ['Squat', 3, 5, 100, 8],
      ['Bench', 3, 8, 60, 7],
      ['Day 2'],
      ['Deadlift', 1, 5, 140, 9],
      ['Week 2'],
      ['Day 1'],
      ['Squat', 3, 5, 105, 8],
      ['Day 2'],
      ['Deadlift', 1, 5, 145, 9],
    ])
    const res = await parseExternalFile(buf)
    expect(res.errors).toEqual([])
    expect(res.weeks).toBe(2)
    expect(res.days).toBe(4)
    expect(res.exerciseCount).toBe(5)

    const first = res.exercises[0]
    expect(first).toMatchObject({
      name: 'Squat', sets: '3', reps: '5', load: '100', rpe: '8',
      weekLabel: 'Week 1', dayLabel: 'Day 1', weekIndex: 0, dayIndex: 0,
    })
  })

  it('resolves CoachBoard-style headers without sets stealing the RPE column', async () => {
    const buf = await buildSheet([
      ['Discipline', 'Sets', 'Reps', 'Load Used', 'Last Set RPE'],
      ['Squat', 3, 5, 100, 8],
    ])
    const res = await parseExternalFile(buf)
    expect(res.columnMapping).toMatchObject({ exercise: 1, sets: 2, reps: 3, load: 4, rpe: 5 })
    expect(res.errors).toEqual([])
  })

  it('converts an RIR column into RPE', async () => {
    const buf = await buildSheet([
      ['Exercise', 'Sets', 'Reps', 'Weight', 'RIR'],
      ['Squat', 3, 5, 100, 2],
    ])
    const res = await parseExternalFile(buf)
    expect(res.columnMapping.rpeFromRir).toBe(true)
    expect(res.exercises[0].rpe).toBe('8') // 10 - 2
    expect(res.exercises[0].load).toBe('100')
  })

  it('does not read a merged week banner as an exercise row', async () => {
    const buf = await buildSheet(
      [
        HEADER,
        ['Week 1'],
        ['Squat', 3, 5, 100, 8],
      ],
      ['A2:E2'],
    )
    const res = await parseExternalFile(buf)
    expect(res.exerciseCount).toBe(1)
    expect(res.weeks).toBe(1)
    expect(res.exercises[0].name).toBe('Squat')
  })

  it('carries the exercise name forward across multi-set sub-rows', async () => {
    const buf = await buildSheet([
      HEADER,
      ['Bench Press', 4, 8, 60, 8],
      [null, 4, 8, 62, 8],
      [null, 4, 6, 64, 9],
    ])
    const res = await parseExternalFile(buf)
    expect(res.exerciseCount).toBe(3)
    expect(res.exercises.every((e) => e.name === 'Bench Press')).toBe(true)
  })

  it('warns but still parses when Load and RPE columns are absent', async () => {
    const buf = await buildSheet([
      ['Exercise', 'Sets', 'Reps'],
      ['Squat', 3, 5],
    ])
    const res = await parseExternalFile(buf)
    expect(res.errors).toEqual([])
    expect(res.columnMapping.load).toBeNull()
    expect(res.columnMapping.rpe).toBeNull()
    expect(res.warnings.some((w) => /Load/i.test(w.message))).toBe(true)
    expect(res.warnings.some((w) => /RPE/i.test(w.message))).toBe(true)
    expect(res.exerciseCount).toBe(1)
  })

  it('rejects a file with no Exercise column', async () => {
    const buf = await buildSheet([
      ['Sets', 'Reps', 'Load', 'RPE'],
      [3, 5, 100, 8],
    ])
    const res = await parseExternalFile(buf)
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.errors[0]).toMatch(/Exercise/)
    expect(res.exercises).toEqual([])
  })

  it('handles reps ranges, AMRAP, bodyweight, units and Swedish decimals', async () => {
    const buf = await buildSheet([
      HEADER,
      ['Squat', 3, '3-5', '82,5', 8],
      ['Pullup', 3, 'AMRAP', 'BW', 8],
      ['Press', 3, 5, '100 kg', 7],
    ])
    const res = await parseExternalFile(buf)
    expect(res.exercises[0].reps).toBe('3-5')
    expect(res.exercises[0].load).toBe('82.5')
    expect(res.exercises[1].reps).toBe('AMRAP')
    expect(res.exercises[1].load).toBeNull()
    expect(res.exercises[2].load).toBe('100')
    expect(res.warnings.some((w) => /variable reps/i.test(w.message))).toBe(true)
  })

  it('falls back to a single week and day when no markers are present', async () => {
    const buf = await buildSheet([
      HEADER,
      ['Squat', 3, 5, 100, 8],
      ['Bench', 3, 8, 60, 7],
    ])
    const res = await parseExternalFile(buf)
    expect(res.weeks).toBe(1)
    expect(res.days).toBe(1)
    expect(res.exerciseCount).toBe(2)
    expect(res.exercises[0]).toMatchObject({ weekLabel: 'Week 1', dayLabel: 'Day 1' })
  })

  it('warns on a numeric row with no exercise name and no carry-forward', async () => {
    const buf = await buildSheet([
      HEADER,
      ['Day 1'],
      [null, 3, 5, 100, 8],
    ])
    const res = await parseExternalFile(buf)
    expect(res.exerciseCount).toBe(0)
    expect(res.warnings.some((w) => /no exercise name/i.test(w.message))).toBe(true)
  })

  it('reports the vertical layout for stacked-section files', async () => {
    const buf = await buildSheet([HEADER, ['Squat', 3, 5, 100, 8]])
    expect((await parseExternalFile(buf)).layout).toBe('vertical')
  })
})

// ---------------------------------------------------------------------------
// Horizontal layout — weeks as side-by-side column blocks (CoachBoard export).
// ---------------------------------------------------------------------------

// Block columns in export order; offsets: name0 rest1 sets2 reps3 intensity4
// loadCap5 loadUsed6 rpe7. Blocks are BLOCK wide with one gap column between.
const BLOCK_COLS = ['Discipline', 'Rest Time(mins)', 'Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
const BLOCK = BLOCK_COLS.length
const weekStart = (w: number) => 2 + w * (BLOCK + 1) // 1-based start column of week w

interface WeekCell { sets?: Cell; reps?: Cell; intensity?: Cell; loadCap?: Cell; loadUsed?: Cell; rpe?: Cell }
interface HRow { name?: string; weeks: WeekCell[] }
interface HDay { day: string; rows: HRow[] }

async function buildHorizontalSheet(numWeeks: number, days: HDay[]): Promise<Buffer> {
  const grid: Cell[][] = []
  const place = (row: Cell[], w: number, vals: Cell[]) => {
    const start = weekStart(w) - 1
    vals.forEach((v, off) => { if (v !== null && v !== undefined && v !== '') row[start + off] = v })
  }

  const banner: Cell[] = []
  for (let w = 0; w < numWeeks; w++) banner[weekStart(w) - 1] = `Week ${w + 1}`
  grid.push(banner)

  for (const day of days) {
    const header: Cell[] = []
    header[0] = day.day
    for (let w = 0; w < numWeeks; w++) place(header, w, BLOCK_COLS)
    grid.push(header)

    for (const r of day.rows) {
      const xrow: Cell[] = []
      for (let w = 0; w < numWeeks; w++) {
        const c = r.weeks[w] ?? {}
        place(xrow, w, [r.name ?? '', '', c.sets ?? '', c.reps ?? '', c.intensity ?? '', c.loadCap ?? '', c.loadUsed ?? '', c.rpe ?? ''])
      }
      grid.push(xrow)
    }
    grid.push([]) // blank separator
  }
  return buildSheet(grid)
}

// 4-week program: Monday (Squat ×2 sets + Bench), Wednesday (Deadlift).
const W = (sets: Cell, reps: Cell, intensity: Cell, loadCap: Cell, loadUsed: Cell, rpe: Cell): WeekCell =>
  ({ sets, reps, intensity, loadCap, loadUsed, rpe })

const HORIZONTAL: HDay[] = [
  {
    day: 'Monday',
    rows: [
      { name: 'Squat', weeks: [W(3, 5, '6', 150, 150, 7), W(3, 5, '6,5', 155, 155, 7), W(3, 5, '7', 160, 160, 8), W(3, 5, '7,5', 165, 165, 8)] },
      { name: '', weeks: [W(3, 5, '-5%', null, 142, 6), W(3, 5, '-5%', null, 147, 6), W(3, 5, '-5%', null, 152, 7), W(3, 5, '-5%', null, 157, 7)] },
      { name: 'Bench', weeks: [W(3, 8, '1RIR', null, 100, 8), W(3, 8, '1RIR', null, 102, 8), W(3, 8, '1RIR', null, 105, 8), W(3, 8, '1RIR', null, 107, 9)] },
    ],
  },
  {
    day: 'Wednesday',
    rows: [
      { name: 'Deadlift', weeks: [W(1, 5, '6', 200, 200, 7), W(1, 5, '6,5', 205, 205, 7), W(1, 5, '7', 210, 210, 8), W(1, 5, '7,5', 215, 215, 8)] },
    ],
  },
]

describe('parseExternalFile (horizontal layout)', () => {
  it('detects the weeks-across-columns layout and counts weeks/days/exercises', async () => {
    const res = await parseExternalFile(await buildHorizontalSheet(4, HORIZONTAL))
    expect(res.layout).toBe('horizontal')
    expect(res.errors).toEqual([])
    expect(res.weeks).toBe(4)
    expect(res.days).toBe(8)        // 2 days × 4 weeks
    expect(res.exerciseCount).toBe(16) // 4 rows/week × 4 weeks
  })

  it('reads fields from the correct week block', async () => {
    const res = await parseExternalFile(await buildHorizontalSheet(4, HORIZONTAL))
    const w1 = res.exercises.find((e) => e.weekIndex === 0 && e.name === 'Squat')!
    expect(w1).toMatchObject({ sets: '3', reps: '5', intensity: '6', load: '150', rpe: '7', loadCap: 150 })
    const w3 = res.exercises.find((e) => e.weekIndex === 2 && e.name === 'Squat' && e.sheetRow === w1.sheetRow)!
    expect(w3.load).toBe('160') // week 3's load, not week 1's
  })

  it('carries the exercise name forward across sub-set rows', async () => {
    const res = await parseExternalFile(await buildHorizontalSheet(4, HORIZONTAL))
    const week1Day0 = res.exercises.filter((e) => e.weekIndex === 0 && e.dayIndex === 0)
    expect(week1Day0.map((e) => e.name)).toEqual(['Squat', 'Squat', 'Bench'])
  })

  it('maps each day to its real weekday offset', async () => {
    const res = await parseExternalFile(await buildHorizontalSheet(4, HORIZONTAL))
    expect(res.exercises.find((e) => e.name === 'Deadlift')!.dayIndex).toBe(2) // Wednesday
  })
})

// Layout B: exercise name written ONCE in a left column; week blocks hold only
// the numbers (Sets, Reps, Intensity, Load Cap, Load Used, RPE). Common in
// powerlifting templates. Col 1 = day, col 2 = Discipline (shared), then blocks.
const NUM_COLS = ['Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
const NB = NUM_COLS.length
const weekStartB = (w: number) => 3 + w * (NB + 1) // blocks start at col 3, 1 gap col

async function buildSharedNameSheet(numWeeks: number): Promise<Buffer> {
  const grid: Cell[][] = []
  const place = (row: Cell[], w: number, vals: Cell[]) => {
    const s = weekStartB(w) - 1
    vals.forEach((v, off) => { if (v !== null && v !== undefined && v !== '') row[s + off] = v })
  }
  const banner: Cell[] = []
  for (let w = 0; w < numWeeks; w++) banner[weekStartB(w) - 1] = `Week ${w + 1}`
  grid.push(banner)

  // Monday header: col1 day, col2 Discipline label, then numeric labels per block.
  const header: Cell[] = []
  header[0] = 'Monday'
  header[1] = 'Discipline'
  for (let w = 0; w < numWeeks; w++) place(header, w, NUM_COLS)
  grid.push(header)

  // Squat (2 sets — name only on first row), then Bench. Loads differ per week.
  const addRow = (name: string, base: number) => {
    const row: Cell[] = []
    if (name) row[1] = name
    for (let w = 0; w < numWeeks; w++) place(row, w, [3, 5, '7', base + w * 5, base + w * 5, 8])
    grid.push(row)
  }
  addRow('Squat', 150)
  addRow('', 142)      // sub-set: blank name → carries "Squat"
  addRow('Bench', 100)
  grid.push([])
  return grid.length ? buildSheet(grid) : buildSheet([[]])
}

describe('parseExternalFile (horizontal, shared name column)', () => {
  it('reads a single left-side Discipline column across all week blocks', async () => {
    const res = await parseExternalFile(await buildSharedNameSheet(3))
    expect(res.layout).toBe('horizontal')
    expect(res.errors).toEqual([])
    expect(res.weeks).toBe(3)
    expect(res.exerciseCount).toBe(9) // 3 rows × 3 weeks

    const w0 = res.exercises.filter((e) => e.weekIndex === 0)
    expect(w0.map((e) => e.name)).toEqual(['Squat', 'Squat', 'Bench'])
    expect(w0[0]).toMatchObject({ sets: '3', reps: '5', load: '150', rpe: '8' })

    // Correct per-week loads pulled from the right block.
    expect(res.exercises.find((e) => e.weekIndex === 2 && e.name === 'Bench')!.load).toBe('110')
  })

  it('recovers Excel-mangled rep ranges (dates) and percentage intensities', async () => {
    // Layout B, 2 weeks. Excel turned reps "4-8" into a date and "-7.5%" into -0.075.
    const cols = ['Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
    const ws = (w: number) => 3 + w * (cols.length + 1)
    const grid: unknown[][] = []
    const place = (row: unknown[], w: number, vals: unknown[]) => {
      const s = ws(w) - 1
      vals.forEach((v, o) => { if (v !== null && v !== undefined && v !== '') row[s + o] = v })
    }
    const banner: unknown[] = []
    for (let w = 0; w < 2; w++) banner[ws(w) - 1] = `Week ${w + 1}`
    grid.push(banner)
    const header: unknown[] = []
    header[0] = 'Monday'
    header[1] = 'Discipline'
    for (let w = 0; w < 2; w++) place(header, w, cols)
    grid.push(header)
    const row: unknown[] = []
    row[1] = 'Pec Dec'
    for (let w = 0; w < 2; w++) place(row, w, [1, new Date(Date.UTC(2025, 3, 8)), -0.075, null, 30, 9])
    grid.push(row)
    grid.push([])

    const res = await parseExternalFile(await buildSheet(grid as Cell[][]))
    const e = res.exercises[0]
    expect(e.reps).toBe('4-8')
    expect(e.intensity).toBe('-7.5%')
  })
})
