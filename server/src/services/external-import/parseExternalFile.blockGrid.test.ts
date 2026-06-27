import { describe, it, expect } from 'vitest'
import { parseExternalFile } from '../externalImportService.js'
import { type GDay, buildGridSheet } from './__testutils__/buildSheet.js'

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
