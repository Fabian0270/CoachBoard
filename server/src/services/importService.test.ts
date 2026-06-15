import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  createProgram,
  setProgramDuration,
  createWorkout,
  createExercise,
  findProgramForExport,
} from './programService.js'
import { parseImportFile, commitImport } from './importService.js'
import {
  buildExportColumnKeys,
  weekColumnStart,
} from 'coachboard-shared/exportLayout'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an xlsx buffer that matches the export layout for a given program.
 * Replays the same algorithm as the exporter so the importer can read it.
 * Cell values must be supplied via the `fill` callback.
 */
async function buildSheetForProgram(
  programId: string,
  fill: (ws: ExcelJS.Worksheet, row: number, col: number, exercise: { id: string; name: string }) => void,
): Promise<Buffer> {
  const data = await findProgramForExport(programId)
  if (!data) throw new Error('Program not found')
  const { program, workouts, exercises } = data
  if (!program.start_date || !program.end_date) throw new Error('No date range')

  const enabledSet = program.enabled_columns
    ? (() => {
        try {
          const p = JSON.parse(program.enabled_columns)
          return Array.isArray(p) ? new Set(p as string[]) : new Set(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])
        } catch { return new Set(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe']) }
      })()
    : new Set(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])

  const columnKeys = buildExportColumnKeys([...enabledSet])
  const exportColumnCount = columnKeys.length
  const getWeekColStart = (wi: number) => weekColumnStart(wi, exportColumnCount)

  const toIso = (d: Date) => d.toISOString().slice(0, 10)
  const mondayOf = (date: Date) => {
    const offset = date.getUTCDay() === 0 ? -6 : 1 - date.getUTCDay()
    const m = new Date(date)
    m.setUTCDate(date.getUTCDate() + offset)
    return m
  }

  const exercisesByWorkout = new Map<string, typeof exercises>()
  for (const ex of exercises) {
    const list = exercisesByWorkout.get(ex.workout_id) ?? []
    list.push(ex)
    exercisesByWorkout.set(ex.workout_id, list)
  }
  const workoutByDate = new Map<string, typeof workouts[number]>()
  for (const w of workouts) {
    if (w.scheduled_date) workoutByDate.set(w.scheduled_date, w)
  }

  const [sy, sm, sd] = program.start_date.split('-').map(Number)
  const [ey, em, ed] = program.end_date.split('-').map(Number)
  const startMonday = mondayOf(new Date(Date.UTC(sy, sm - 1, sd)))
  const endDate = new Date(Date.UTC(ey, em - 1, ed))
  const numWeeks = Math.max(
    1,
    Math.ceil((Math.round((endDate.getTime() - startMonday.getTime()) / 86400000) + 1) / 7),
  )

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Program')

  type ExRow = typeof exercises[number]

  let sheetRow = 2
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    const perWeek: ExRow[][] = []
    let maxRows = 0
    for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
      const date = new Date(startMonday)
      date.setUTCDate(startMonday.getUTCDate() + weekIndex * 7 + dayOfWeek)
      const workout = workoutByDate.get(toIso(date))
      const exList = workout ? (exercisesByWorkout.get(workout.id) ?? []) : []
      perWeek.push(exList)
      if (exList.length > maxRows) maxRows = exList.length
    }

    sheetRow++ // past header row
    const bodyCount = Math.max(maxRows, 1)
    for (let r = 0; r < bodyCount; r++) {
      for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
        const ex = perWeek[weekIndex][r]
        if (!ex) continue
        fill(ws, sheetRow, getWeekColStart(weekIndex), ex)
      }
      sheetRow++
    }
    sheetRow++ // blank separator
  }

  const raw = await wb.xlsx.writeBuffer()
  return Buffer.from(raw as ArrayBuffer)
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let athleteId: string
let squatId: string
let benchId: string
let programId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const athlete = await createAthlete({ name: 'Import Test Athlete' })
  athleteId = athlete.id

  // Program: 1 week, all columns enabled, starts Monday 2026-06-08
  const program = await createProgram({
    athlete_id: athleteId,
    name: 'Import Test Program',
    enabled_columns: ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'],
  })
  programId = program.id
  await setProgramDuration(programId, '2026-06-08', 2) // 2 weeks

  // Monday 2026-06-08 — two exercises
  const mon = await createWorkout({ program_id: programId, name: 'Monday', scheduled_date: '2026-06-08' })
  const squat = await createExercise({ workout_id: mon.id, name: 'Squat', sets: '3', reps: '5', order_index: 0 })
  const bench = await createExercise({ workout_id: mon.id, name: 'Bench Press', sets: '3', reps: '8', order_index: 1 })
  squatId = squat.id
  benchId = bench.id

  // Wednesday 2026-06-10 — one exercise
  const wed = await createWorkout({ program_id: programId, name: 'Wednesday', scheduled_date: '2026-06-10' })
  await createExercise({ workout_id: wed.id, name: 'Deadlift', sets: '3', reps: '3', order_index: 0 })

  // Week 2 Monday 2026-06-15 — same structure
  const mon2 = await createWorkout({ program_id: programId, name: 'Monday W2', scheduled_date: '2026-06-15' })
  await createExercise({ workout_id: mon2.id, name: 'Squat', sets: '3', reps: '5', order_index: 0 })
  await createExercise({ workout_id: mon2.id, name: 'Bench Press', sets: '3', reps: '8', order_index: 1 })
})

// ---------------------------------------------------------------------------
// parseImportFile
// ---------------------------------------------------------------------------

describe('parseImportFile', () => {
  it('round-trip: reads Load Used and RPE at the correct cell positions', async () => {
    const columnKeys = buildExportColumnKeys(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])
    const loadUsedOffset = columnKeys.indexOf('load_used')
    const rpeOffset = columnKeys.indexOf('rpe')

    const buf = await buildSheetForProgram(programId, (ws, row, col, ex) => {
      if (ex.name === 'Squat') {
        ws.getCell(row, col + loadUsedOffset).value = 150
        ws.getCell(row, col + rpeOffset).value = 8
      } else if (ex.name === 'Bench Press') {
        ws.getCell(row, col + loadUsedOffset).value = 100
        ws.getCell(row, col + rpeOffset).value = 7.5
      }
    })

    const result = await parseImportFile(buf, programId)

    // Should find 4 matches: Squat W1, Bench W1, Squat W2, Bench W2
    expect(result.matched.length).toBe(4)
    expect(result.warnings).toHaveLength(0)

    const squatW1 = result.matched.find((m) => m.exerciseName === 'Squat' && m.weekIndex === 0)
    expect(squatW1?.load_used).toBe('150')
    expect(squatW1?.rpe).toBe('8')

    const benchW1 = result.matched.find((m) => m.exerciseName === 'Bench Press' && m.weekIndex === 0)
    expect(benchW1?.load_used).toBe('100')
    expect(benchW1?.rpe).toBe('7.5')
  })

  it('accepts Swedish decimal commas (82,5) and normalises to period', async () => {
    const columnKeys = buildExportColumnKeys(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])
    const loadUsedOffset = columnKeys.indexOf('load_used')

    const buf = await buildSheetForProgram(programId, (ws, row, col, ex) => {
      if (ex.name === 'Squat') {
        ws.getCell(row, col + loadUsedOffset).value = '147,5'
      }
    })

    const result = await parseImportFile(buf, programId)
    const squatW1 = result.matched.find((m) => m.exerciseName === 'Squat' && m.weekIndex === 0)
    expect(squatW1?.load_used).toBe('147.5')
  })

  it('reports a name mismatch warning but still includes the match', async () => {
    const columnKeys = buildExportColumnKeys(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])
    const nameOffset = columnKeys.indexOf('name')
    const rpeOffset = columnKeys.indexOf('rpe')

    const buf = await buildSheetForProgram(programId, (ws, row, col, ex) => {
      if (ex.name === 'Squat') {
        ws.getCell(row, col + nameOffset).value = 'Back Squat' // athlete renamed it
        ws.getCell(row, col + rpeOffset).value = 9
      }
    })

    const result = await parseImportFile(buf, programId)
    const squatMatches = result.matched.filter((m) => m.weekIndex === 0 && m.dayOfWeek === 0 && m.rowIndex === 0)
    expect(squatMatches.length).toBe(1)
    expect(squatMatches[0].nameMismatch).toBe(true)
    expect(squatMatches[0].rpe).toBe('9')
    expect(result.warnings.some((w) => w.message.includes('Back Squat'))).toBe(true)
  })

  it('skips exercises with no filled tracking values (no match entry)', async () => {
    // Only fill Squat W1; everything else is empty
    const columnKeys = buildExportColumnKeys(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])
    const rpeOffset = columnKeys.indexOf('rpe')

    const buf = await buildSheetForProgram(programId, (ws, row, col, ex) => {
      if (ex.name === 'Squat') {
        ws.getCell(row, col + rpeOffset).value = 8.5
      }
    })

    const result = await parseImportFile(buf, programId)
    // Squat appears in W1 Monday and W2 Monday → 2 matches
    const squatMatches = result.matched.filter((m) => m.exerciseName === 'Squat')
    expect(squatMatches.length).toBe(2)
    const benchMatches = result.matched.filter((m) => m.exerciseName === 'Bench Press')
    expect(benchMatches.length).toBe(0) // Bench cells were empty
  })

  it('returns a warning when the program has no tracking columns enabled', async () => {
    const noTrackingProgram = await createProgram({
      athlete_id: athleteId,
      name: 'No tracking columns',
      enabled_columns: [],
    })
    await setProgramDuration(noTrackingProgram.id, '2026-06-08', 1)
    const mon = await createWorkout({ program_id: noTrackingProgram.id, name: 'Monday', scheduled_date: '2026-06-08' })
    await createExercise({ workout_id: mon.id, name: 'Squat', sets: '3', reps: '5', order_index: 0 })

    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Program')
    const raw = await wb.xlsx.writeBuffer()
    const buf = Buffer.from(raw as ArrayBuffer)

    const result = await parseImportFile(buf, noTrackingProgram.id)
    expect(result.matched).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0].message).toMatch(/Load Used|Last Set RPE/)
  })
})

// ---------------------------------------------------------------------------
// commitImport
// ---------------------------------------------------------------------------

describe('commitImport', () => {
  it('writes load_used and rpe into the database', async () => {
    const result = await commitImport(programId, [
      { exerciseId: squatId, load_used: '140', rpe: '8' },
      { exerciseId: benchId, load_used: '90', rpe: '7' },
    ])

    expect(result.updatedCount).toBe(2)

    // Verify via re-fetch
    const data = await findProgramForExport(programId)
    const squat = data!.exercises.find((e) => e.id === squatId)
    const bench = data!.exercises.find((e) => e.id === benchId)
    expect(squat?.load_used).toBe('140')
    expect(squat?.rpe).toBe('8')
    expect(bench?.load_used).toBe('90')
    expect(bench?.rpe).toBe('7')
  })

  it('silently ignores exerciseIds that do not belong to the program', async () => {
    const result = await commitImport(programId, [
      { exerciseId: '00000000-0000-0000-0000-000000000000', load_used: '999', rpe: '10' },
    ])
    expect(result.updatedCount).toBe(0)
  })

  it('returns 0 for an empty matches array', async () => {
    const result = await commitImport(programId, [])
    expect(result.updatedCount).toBe(0)
  })
})
