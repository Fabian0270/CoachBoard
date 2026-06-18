import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseExternalFile, guessFocus } from './externalImportService.js'
import type { ExternalExerciseRow } from 'coachboard-shared'

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

  it('recovers a rep range from a formula cell whose cached result is a Date', async () => {
    // Weeks copy each other with "=K31"; Excel caches the result as a Date. The
    // cell is { formula, result: Date }, not a bare Date — must still ISO-format.
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    HEADER.forEach((h, c) => { ws.getCell(1, c + 1).value = h })
    ws.getCell(2, 1).value = 'RDL'
    ws.getCell(2, 2).value = 3
    ws.getCell(2, 3).value = { formula: 'Z1', result: new Date(Date.UTC(2022, 7, 6)) } // Aug 6
    ws.getCell(2, 4).value = 100
    ws.getCell(2, 5).value = 8
    const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)
    const res = await parseExternalFile(buf)
    expect(res.exercises[0].reps).toBe('6-8') // ordered low-high, not "8-6"
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

// ---------------------------------------------------------------------------
// Block-grid layout — weeks as side-by-side blocks whose
// lead column holds repeating "DAY n" section rows, the "Week n" banner sits one
// column to the right of each block, and RPE is written "@6" / "@6-7".
// ---------------------------------------------------------------------------

// Block per week: Movement(0) SETS(1) REPS(2) LOAD(3) RPE(4) eRPE(5), then a
// gap column. Block width 7 → starts at col 2, 9, 16, …
const GRID_COLS = ['Movement', 'SETS', 'REPS', 'LOAD', 'RPE', 'eRPE']
const GBLOCK = GRID_COLS.length + 1
const gridStart = (w: number) => 2 + w * GBLOCK // 1-based block-start (the Movement / DAY column)

interface GWeekCell { sets?: Cell; reps?: Cell; load?: Cell; rpe?: Cell; erpe?: Cell }
interface GRow { name?: string; weeks: GWeekCell[] }
interface GDay { day: string; rows: GRow[] }

async function buildGridSheet(numWeeks: number, days: GDay[]): Promise<Buffer> {
  const grid: Cell[][] = []
  const place = (row: Cell[], w: number, vals: Cell[]) => {
    const s = gridStart(w) - 1
    vals.forEach((v, off) => { if (v !== null && v !== undefined && v !== '') row[s + off] = v })
  }

  // Banner row: each block's lead column holds the FIRST "DAY n" label, with the
  // "Week n" banner one column to its right.
  const banner: Cell[] = []
  for (let w = 0; w < numWeeks; w++) {
    banner[gridStart(w) - 1] = days[0].day
    banner[gridStart(w)] = `Week ${w + 1}`
  }
  grid.push(banner)

  days.forEach((day, di) => {
    // DAY 2+ get their own section row (DAY 1 already lives on the banner row).
    if (di > 0) {
      const dayRow: Cell[] = []
      for (let w = 0; w < numWeeks; w++) dayRow[gridStart(w) - 1] = day.day
      grid.push(dayRow)
    }
    // Header row repeats under every day.
    const header: Cell[] = []
    for (let w = 0; w < numWeeks; w++) place(header, w, GRID_COLS)
    grid.push(header)

    for (const r of day.rows) {
      const xrow: Cell[] = []
      for (let w = 0; w < numWeeks; w++) {
        const c = r.weeks[w] ?? {}
        place(xrow, w, [r.name ?? '', c.sets ?? '', c.reps ?? '', c.load ?? '', c.rpe ?? '', c.erpe ?? ''])
      }
      grid.push(xrow)
    }
  })
  return buildSheet(grid)
}

describe('parseExternalFile (block-grid layout)', () => {
  const PROGRAM: GDay[] = [
    {
      day: 'DAY 1',
      rows: [
        { name: 'Squat', weeks: [
          { sets: 1, reps: 3, load: 180, rpe: '@6', erpe: 6 },
          { sets: 1, reps: 3, load: 190, rpe: '@7-8', erpe: 7 },
        ] },
        { name: 'Squat', weeks: [ // sub-set; explicit repeated name
          { sets: 2, reps: 5, load: 165, rpe: '@6', erpe: 6 },
          { sets: 3, reps: 5, load: 165, rpe: '@6', erpe: 6 },
        ] },
        { name: 'Bench Press', weeks: [ // backoff written as a fraction in RPE col
          { sets: 1, reps: 5, load: 115, rpe: -0.05, erpe: 6 },
          { sets: 1, reps: 5, load: 125, rpe: -0.05, erpe: 7 },
        ] },
      ],
    },
    {
      day: 'DAY 2',
      rows: [
        { name: 'Deadlift', weeks: [
          { sets: 1, reps: 1, load: 230, rpe: '@6', erpe: 6 },
          { sets: 1, reps: 1, load: 240, rpe: '@6-7', erpe: 8 },
        ] },
      ],
    },
  ]

  it('detects the layout and counts weeks / day-blocks / exercises', async () => {
    const res = await parseExternalFile(await buildGridSheet(2, PROGRAM))
    expect(res.layout).toBe('block-grid')
    expect(res.errors).toEqual([])
    expect(res.weeks).toBe(2)
    expect(res.days).toBe(4)          // 2 days × 2 weeks
    expect(res.exerciseCount).toBe(8) // 4 rows × 2 weeks
    expect(res.columnMapping).toMatchObject({ exercise: 2, sets: 3, reps: 4, load: 5, rpe: 6 })
  })

  it('reads each field from the correct week block', async () => {
    const res = await parseExternalFile(await buildGridSheet(2, PROGRAM))
    const w0 = res.exercises.find((e) => e.weekIndex === 0 && e.name === 'Squat')!
    expect(w0).toMatchObject({ sets: '1', reps: '3', load: '180', rpe: '6', dayLabel: 'DAY 1', dayIndex: 0 })
    const w1 = res.exercises.find((e) => e.weekIndex === 1 && e.name === 'Squat' && e.sheetRow === w0.sheetRow)!
    expect(w1.load).toBe('190') // week 2's load, not week 1's
  })

  it('strips the "@" from RPE and keeps a range as-is', async () => {
    const res = await parseExternalFile(await buildGridSheet(2, PROGRAM))
    const dl = res.exercises.find((e) => e.weekIndex === 1 && e.name === 'Deadlift')!
    expect(dl.rpe).toBe('6-7')
  })

  it('routes a load-backoff fraction in the RPE column to intensity', async () => {
    const res = await parseExternalFile(await buildGridSheet(2, PROGRAM))
    const bench = res.exercises.find((e) => e.name === 'Bench Press' && e.weekIndex === 0)!
    expect(bench.rpe).toBeNull()
    expect(bench.intensity).toBe('-5%')
  })

  it('groups exercises under their DAY section and ignores the eRPE column', async () => {
    const res = await parseExternalFile(await buildGridSheet(2, PROGRAM))
    const w0 = res.exercises.filter((e) => e.weekIndex === 0)
    expect(w0.filter((e) => e.dayIndex === 0).map((e) => e.name)).toEqual(['Squat', 'Squat', 'Bench Press'])
    expect(w0.filter((e) => e.dayIndex === 1).map((e) => e.name)).toEqual(['Deadlift'])
    // eRPE (executed) is NOT mapped — rpe comes from the prescribed RPE column.
    expect(w0.find((e) => e.name === 'Deadlift')!.rpe).toBe('6')
  })

  it('does not leak shared-formula / empty-object cells as exercise rows', async () => {
    // Append an empty DAY 3 whose cells are formula objects with no cached value.
    const buf = await buildGridSheet(2, [
      ...PROGRAM,
      { day: 'DAY 3', rows: [{ name: '', weeks: [{}, {}] }] },
    ])
    const res = await parseExternalFile(buf)
    expect(res.exercises.some((e) => /object/i.test(e.name))).toBe(false)
    expect(res.days).toBe(4) // DAY 3 produced no exercises
  })

  it('carries the exercise name forward across blank sub-set rows', async () => {
    const res = await parseExternalFile(await buildGridSheet(1, [
      {
        day: 'DAY 1',
        rows: [
          { name: 'Squat', weeks: [{ sets: 1, reps: 5, load: 180, rpe: '@7' }] },
          { name: '', weeks: [{ sets: 2, reps: 5, load: 160, rpe: '@6' }] }, // blank → carries "Squat"
        ],
      },
    ]))
    expect(res.exercises.map((e) => e.name)).toEqual(['Squat', 'Squat'])
  })
})

// ---------------------------------------------------------------------------
// Week-grid layout — weeks as side-by-side blocks whose lead
// column holds BOTH movement names and weekday day-sections (English/Swedish),
// the Set/Reps/RPE/Load header appears ONCE (the first day shares it), the
// "Week n" banner sits one column right of each block's lead column, RPE is
// written "@6"/"@6-7", and trailing "eRpe"/"e1RM" columns are ignored.
// ---------------------------------------------------------------------------

// Block per week: name/day(0) Set(1) Reps(2) RPE(3) Load(4) eRpe(5) e1RM(6),
// then a gap column → block width 8, lead columns at 1, 9, 17, …
const WG_HEAD = ['Set', 'Reps', 'RPE', 'Load', 'eRpe', 'e1RM']
const WBLOCK = 8
const wgLead = (w: number) => 1 + w * WBLOCK // 1-based lead column of week w

interface WGWeek { sets?: Cell; reps?: Cell; rpe?: Cell; load?: Cell; erpe?: Cell }
interface WGRow { name?: string; weeks: WGWeek[] }
interface WGDay { day: string; rows: WGRow[] }

async function buildWeekGridSheet(numWeeks: number, days: WGDay[]): Promise<Buffer> {
  const grid: Cell[][] = []
  // Data columns start one column right of the lead column (i.e. on the banner).
  const putData = (row: Cell[], w: number, vals: Cell[]) => {
    vals.forEach((v, o) => { if (v !== null && v !== undefined && v !== '') row[wgLead(w) + o] = v })
  }

  // Banner row: "Week n" sits on the banner column (lead + 1).
  const banner: Cell[] = []
  for (let w = 0; w < numWeeks; w++) banner[wgLead(w)] = `Week ${w + 1}`
  grid.push(banner)

  days.forEach((day, di) => {
    if (di === 0) {
      // Header row — also carries the first day's weekday label in the lead column.
      const header: Cell[] = []
      for (let w = 0; w < numWeeks; w++) {
        header[wgLead(w) - 1] = day.day
        putData(header, w, WG_HEAD)
      }
      grid.push(header)
    } else {
      // Bare weekday section row (the header is NOT repeated under later days).
      const dayRow: Cell[] = []
      for (let w = 0; w < numWeeks; w++) dayRow[wgLead(w) - 1] = day.day
      grid.push(dayRow)
    }
    for (const r of day.rows) {
      const xrow: Cell[] = []
      for (let w = 0; w < numWeeks; w++) {
        if (r.name) xrow[wgLead(w) - 1] = r.name
        const c = r.weeks[w] ?? {}
        putData(xrow, w, [c.sets ?? '', c.reps ?? '', c.rpe ?? '', c.load ?? '', c.erpe ?? ''])
      }
      grid.push(xrow)
    }
  })
  return buildSheet(grid)
}

const WG_PROGRAM: WGDay[] = [
  {
    day: 'Tisdag', // Tuesday → dayIndex 1
    rows: [
      { name: 'Competition Deadlift', weeks: [
        { sets: 1, reps: 1, rpe: '@5-6', load: 240, erpe: 5 },
        { sets: 1, reps: 1, rpe: '@7', load: 255, erpe: 7 },
      ] },
      { name: '', weeks: [ // sub-set; blank name → carries "Competition Deadlift"
        { sets: 2, reps: 4, rpe: '@5-6', load: 210, erpe: 6 },
        { sets: 3, reps: 4, rpe: '@6', load: 220, erpe: 6 },
      ] },
      { name: 'Bench Press', weeks: [
        { sets: 3, reps: 5, rpe: '@6', load: 125, erpe: 6 },
        { sets: 3, reps: 5, rpe: '@6', load: 130, erpe: 6 },
      ] },
    ],
  },
  {
    day: 'Torsdag', // Thursday → dayIndex 3
    rows: [
      { name: 'SSB Squat', weeks: [
        { sets: 3, reps: 5, rpe: '@6', load: 130, erpe: 6 },
        { sets: 3, reps: 5, rpe: '@6-7', load: 140, erpe: 6.5 },
      ] },
    ],
  },
]

describe('parseExternalFile (week-grid layout)', () => {
  it('detects the layout and counts weeks / day-blocks / exercises', async () => {
    const res = await parseExternalFile(await buildWeekGridSheet(2, WG_PROGRAM))
    expect(res.layout).toBe('week-grid')
    expect(res.errors).toEqual([])
    expect(res.weeks).toBe(2)
    expect(res.days).toBe(4)          // 2 days × 2 weeks
    expect(res.exerciseCount).toBe(8) // 4 rows × 2 weeks
    expect(res.columnMapping).toMatchObject({ exercise: 1, sets: 2, reps: 3, load: 5, rpe: 4 })
  })

  it('reads each field from the correct week block', async () => {
    const res = await parseExternalFile(await buildWeekGridSheet(2, WG_PROGRAM))
    const w0 = res.exercises.find((e) => e.weekIndex === 0 && e.name === 'Competition Deadlift')!
    expect(w0).toMatchObject({ sets: '1', reps: '1', load: '240', rpe: '5-6', dayLabel: 'Tisdag' })
    const w1 = res.exercises.find((e) => e.weekIndex === 1 && e.name === 'Competition Deadlift' && e.sheetRow === w0.sheetRow)!
    expect(w1.load).toBe('255') // week 2's load, not week 1's
    expect(w1.rpe).toBe('7')
  })

  it('maps Swedish weekday section labels to real weekday offsets', async () => {
    const res = await parseExternalFile(await buildWeekGridSheet(2, WG_PROGRAM))
    expect(res.exercises.find((e) => e.name === 'Competition Deadlift')!.dayIndex).toBe(1) // Tisdag = Tue
    expect(res.exercises.find((e) => e.name === 'SSB Squat')!.dayIndex).toBe(3)            // Torsdag = Thu
  })

  it('carries the exercise name forward across blank sub-set rows', async () => {
    const res = await parseExternalFile(await buildWeekGridSheet(2, WG_PROGRAM))
    const day1 = res.exercises.filter((e) => e.weekIndex === 0 && e.dayIndex === 1)
    expect(day1.map((e) => e.name)).toEqual(['Competition Deadlift', 'Competition Deadlift', 'Bench Press'])
  })

  it('preserves the real "Week n" banner text and ignores the eRpe column', async () => {
    const res = await parseExternalFile(await buildWeekGridSheet(2, WG_PROGRAM))
    expect(res.exercises.find((e) => e.weekIndex === 0)!.weekLabel).toBe('Week 1')
    // rpe comes from the prescribed RPE column ("@5-6"), never from eRpe (5).
    expect(res.exercises.find((e) => e.weekIndex === 0 && e.name === 'Competition Deadlift')!.rpe).toBe('5-6')
  })
})

describe('guessFocus', () => {
  const row = (weekIndex: number, reps: string | null, rpe: string | null): ExternalExerciseRow => ({
    weekIndex, dayIndex: 0, weekLabel: `Week ${weekIndex + 1}`, dayLabel: 'Day 1',
    name: 'Squat', sets: '3', reps, load: '100', rpe, sheetRow: 1,
  })

  it('returns null when there are no numeric reps to judge from', () => {
    expect(guessFocus([row(0, 'AMRAP', null), row(0, null, null)])).toBeNull()
  })

  it('classifies high-rep work as hypertrophy', () => {
    expect(guessFocus([row(0, '10', '7'), row(0, '8', '8'), row(1, '8', '8')])).toBe('hypertrophy')
  })

  it('classifies mid-rep work as strength', () => {
    expect(guessFocus([row(0, '5', '7'), row(0, '5', '8'), row(1, '4', '8')])).toBe('strength')
  })

  it('classifies low-rep work as peaking', () => {
    expect(guessFocus([row(0, '3', '8'), row(0, '2', '9'), row(1, '1', '10')])).toBe('peaking')
  })

  it('uses a near-maximal final week to push a mid-rep block to peaking', () => {
    // Median reps land in the strength band (4–6) but the final week finishes at RPE 9+.
    expect(guessFocus([row(0, '5', '7'), row(1, '5', '9'), row(1, '4', '9.5')])).toBe('peaking')
  })

  it('reads the lower bound of a rep range', () => {
    // "4-6" → lower bound 4 → strength band (a hypertrophy median would need ≥7).
    expect(guessFocus([row(0, '4-6', '8'), row(1, '4-6', '8')])).toBe('strength')
  })
})
