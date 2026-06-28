import ExcelJS from 'exceljs'

// ---------------------------------------------------------------------------
// Shared test scaffolding for the external-import parser suites — builds xlsx
// buffers for each layout the parser must discover (vertical, horizontal,
// shared-name, block-grid, week-grid).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper — build an xlsx buffer from a 2-D grid of cell values.
// Only non-empty cells are written. Optional A1-style merge ranges are applied
// after population (set the master cell value in the grid, leave slaves null).
// ---------------------------------------------------------------------------
export type Cell = string | number | null
export async function buildSheet(rows: Cell[][], merges: string[] = []): Promise<Buffer> {
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

export const HEADER = ['Exercise', 'Sets', 'Reps', 'Load', 'RPE']

// ---------------------------------------------------------------------------
// Horizontal layout — weeks as side-by-side column blocks (CoachBoard export).
// ---------------------------------------------------------------------------

// Block columns in export order; offsets: name0 rest1 sets2 reps3 intensity4
// loadCap5 loadUsed6 rpe7. Blocks are BLOCK wide with one gap column between.
const BLOCK_COLS = ['Discipline', 'Rest Time(mins)', 'Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
const BLOCK = BLOCK_COLS.length
const weekStart = (w: number) => 2 + w * (BLOCK + 1) // 1-based start column of week w

export interface WeekCell { sets?: Cell; reps?: Cell; intensity?: Cell; loadCap?: Cell; loadUsed?: Cell; rpe?: Cell }
export interface HRow { name?: string; weeks: WeekCell[] }
export interface HDay { day: string; rows: HRow[] }

export async function buildHorizontalSheet(numWeeks: number, days: HDay[]): Promise<Buffer> {
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

export const HORIZONTAL: HDay[] = [
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

// Layout B: exercise name written ONCE in a left column; week blocks hold only
// the numbers (Sets, Reps, Intensity, Load Cap, Load Used, RPE). Common in
// powerlifting templates. Col 1 = day, col 2 = Discipline (shared), then blocks.
const NUM_COLS = ['Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
const NB = NUM_COLS.length
const weekStartB = (w: number) => 3 + w * (NB + 1) // blocks start at col 3, 1 gap col

export async function buildSharedNameSheet(numWeeks: number): Promise<Buffer> {
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

// ---------------------------------------------------------------------------
// Block-grid layout — weeks as side-by-side blocks whose lead column holds
// repeating "DAY n" section rows; the "Week n" banner sits one column right.
// ---------------------------------------------------------------------------

// Block per week: Movement(0) SETS(1) REPS(2) LOAD(3) RPE(4) eRPE(5), then a
// gap column. Block width 7 → starts at col 2, 9, 16, …
const GRID_COLS = ['Movement', 'SETS', 'REPS', 'LOAD', 'RPE', 'eRPE']
const GBLOCK = GRID_COLS.length + 1
const gridStart = (w: number) => 2 + w * GBLOCK // 1-based block-start (the Movement / DAY column)

export interface GWeekCell { sets?: Cell; reps?: Cell; load?: Cell; rpe?: Cell; erpe?: Cell }
export interface GRow { name?: string; weeks: GWeekCell[] }
export interface GDay { day: string; rows: GRow[] }

export async function buildGridSheet(numWeeks: number, days: GDay[]): Promise<Buffer> {
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

// ---------------------------------------------------------------------------
// Week-grid layout — weeks as side-by-side blocks whose lead column holds BOTH
// movement names and weekday day-sections (English/Swedish); the Set/Reps/RPE/
// Load header appears ONCE (the first day shares it); trailing "eRpe"/"e1RM"
// columns are ignored.
// ---------------------------------------------------------------------------

// Block per week: name/day(0) Set(1) Reps(2) RPE(3) Load(4) eRpe(5) e1RM(6),
// then a gap column → block width 8, lead columns at 1, 9, 17, …
const WG_HEAD = ['Set', 'Reps', 'RPE', 'Load', 'eRpe', 'e1RM']
const WBLOCK = 8
const wgLead = (w: number) => 1 + w * WBLOCK // 1-based lead column of week w

export interface WGWeek { sets?: Cell; reps?: Cell; rpe?: Cell; load?: Cell; erpe?: Cell }
export interface WGRow { name?: string; weeks: WGWeek[] }
export interface WGDay { day: string; rows: WGRow[] }

export async function buildWeekGridSheet(numWeeks: number, days: WGDay[]): Promise<Buffer> {
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

export const WG_PROGRAM: WGDay[] = [
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
