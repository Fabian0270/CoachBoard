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
})
