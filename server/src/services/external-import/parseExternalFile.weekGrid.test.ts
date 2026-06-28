import { describe, it, expect } from 'vitest'
import { parseExternalFile } from '../externalImportService.js'
import { buildWeekGridSheet, WG_PROGRAM } from './__testutils__/buildSheet.js'

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
