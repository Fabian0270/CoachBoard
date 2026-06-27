import { describe, it, expect } from 'vitest'
import { parseExternalFile } from '../externalImportService.js'
import {
  type Cell,
  buildSheet,
  buildHorizontalSheet,
  HORIZONTAL,
  buildSharedNameSheet,
} from './__testutils__/buildSheet.js'

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
// Regression: a CoachBoard-style horizontal sheet whose "Week N" banner sits
// OVER the Sets column (two columns right of a shared "Discipline" name column,
// with a "Rest Time" column between). The week-grid detector used to claim this
// layout — pinning the exercise name to the Rest Time column, collapsing every
// day onto Monday and reading only one week. It must parse as `horizontal`.
// ---------------------------------------------------------------------------
function buildBannerOffsetHorizontal(): Cell[][] {
  const grid: Cell[][] = []
  const BLK = ['Sets', 'Reps', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']
  const weekBanner = [4, 11] // 1-based columns of "Week 1" / "Week 2" (over Sets)

  const banner: Cell[] = []
  weekBanner.forEach((c, w) => { banner[c - 1] = `Week ${w + 1}` })
  grid.push(banner)

  // Each day = a header row carrying the weekday in col 1 + a shared Discipline
  // (col 2) / Rest Time (col 3), then exercise rows with the name in col 2.
  const addDay = (day: string, rows: Array<{ name: string; loads: [number, number] }>) => {
    const header: Cell[] = []
    header[0] = day; header[1] = 'Discipline'; header[2] = 'Rest Time(mins)'
    weekBanner.forEach((c) => BLK.forEach((h, i) => { header[c - 1 + i] = h }))
    grid.push(header)
    for (const r of rows) {
      const row: Cell[] = []
      row[1] = r.name
      weekBanner.forEach((c, w) => {
        ;[3, 5, 'RPE 8', r.loads[w], r.loads[w], 8].forEach((v, i) => { row[c - 1 + i] = v as Cell })
      })
      grid.push(row)
    }
  }
  addDay('Monday', [{ name: 'Comp Bench', loads: [150, 155] }])
  addDay('Tuesday', [{ name: 'Comp Squat', loads: [180, 185] }])
  return grid
}

describe('parseExternalFile (horizontal with banner offset over Sets)', () => {
  it('parses as horizontal — name from the Discipline column, not Rest Time', async () => {
    const res = await parseExternalFile(await buildSheet(buildBannerOffsetHorizontal()))
    expect(res.layout).toBe('horizontal')
    expect(res.errors).toEqual([])
    expect(res.weeks).toBe(2)
    expect(res.columnMapping).toMatchObject({ exercise: 2, sets: 4, reps: 5, load: 8, rpe: 9 })

    const names = new Set(res.exercises.map((e) => e.name))
    expect(names.has('Comp Bench')).toBe(true)
    expect(names.has('Comp Squat')).toBe(true)
    expect(names.has('Rest Time(mins)')).toBe(false) // the old week-grid mis-parse

    // Days land on their real weekdays, not all collapsed onto Monday.
    expect(res.exercises.find((e) => e.name === 'Comp Bench')!.dayIndex).toBe(0)  // Monday
    expect(res.exercises.find((e) => e.name === 'Comp Squat')!.dayIndex).toBe(1)  // Tuesday

    // Week 2's load comes from the second block.
    const bench = res.exercises.filter((e) => e.name === 'Comp Bench')
    expect(bench.find((e) => e.weekIndex === 0)!.load).toBe('150')
    expect(bench.find((e) => e.weekIndex === 1)!.load).toBe('155')
  })
})
