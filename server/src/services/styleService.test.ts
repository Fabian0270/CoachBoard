import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import { findProgramForExport } from './programService.js'
import { parseExternalFile, commitExternalProgram } from './externalImportService.js'
import { computeFingerprint, computeStyleProfile, detectPatterns } from './styleService.js'
import type { SuggestionGoal } from 'coachboard-shared'

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

// A 4-week, 1-day strength block: 4 sets, reps 5→3, RPE 7.5→9, load rising.
// Rising intensity + flat volume + 3–6 reps → "Linear Progression" pattern.
const STRENGTH_GRID: Cell[][] = [
  HEADER,
  ['Week 1'], ['Day 1'], ['Squat', 4, 5, 100, 7.5],
  ['Week 2'], ['Day 1'], ['Squat', 4, 5, 105, 8],
  ['Week 3'], ['Day 1'], ['Squat', 4, 4, 110, 8.5],
  ['Week 4'], ['Day 1'], ['Squat', 4, 3, 115, 9],
]

// A 4-week, 1-day block with flat load, flat sets and RPE 8 throughout →
// "Repeated Effort" pattern.
const REPEATED_EFFORT_GRID: Cell[][] = [
  HEADER,
  ['Week 1'], ['Day 1'], ['Squat', 4, 8, 100, 8],
  ['Week 2'], ['Day 1'], ['Squat', 4, 8, 100, 8],
  ['Week 3'], ['Day 1'], ['Squat', 4, 8, 100, 8],
  ['Week 4'], ['Day 1'], ['Squat', 4, 8, 100, 8],
]

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const athlete = await createAthlete({ name: 'Style Athlete' })
  athleteId = athlete.id
})

async function commit(grid: Cell[][], focus: SuggestionGoal, status = 'completed'): Promise<string> {
  const buf = await buildSheet(grid)
  const preview = await parseExternalFile(buf)
  const { programId } = await commitExternalProgram(preview.exercises, {
    athleteId, name: `${focus} block`, status, startDate: '2026-01-05', weeks: preview.weeks, focus,
  })
  return programId
}

describe('computeFingerprint', () => {
  it('derives block length, rep range, RPE arc, volume and intensity ramp', async () => {
    const programId = await commit(STRENGTH_GRID, 'strength')
    const data = await findProgramForExport(programId)
    const fp = computeFingerprint(data!)
    expect(fp.blockWeeks).toBe(4)
    expect(fp.daysPerWeek).toBe(1)
    expect(fp.repRangeBucket).toBe('4-6')
    expect(fp.startRpe).toBe(7.5)
    expect(fp.peakRpe).toBe(9)
    expect(fp.volumeDirection).toBe('flat')   // 4 sets every week
    expect(fp.intensityRamp).toBe('rising')   // load climbs 100 → 115
  })
})

describe('computeStyleProfile', () => {
  it('flags usable:false below the minimum sample size', async () => {
    // No peaking programs have been committed for this athlete's coach.
    const profile = await computeStyleProfile({ focus: 'peaking' })
    expect(profile.usable).toBe(false)
    expect(profile.sampleSize).toBe(0)
    expect(profile.preferredBlockWeeks).toBeNull()
  })

  it('aggregates ≥3 programs of a focus into a usable profile', async () => {
    await commit(STRENGTH_GRID, 'strength')
    await commit(STRENGTH_GRID, 'strength')
    // (one strength program already exists from the fingerprint test → ≥3 total)

    const profile = await computeStyleProfile({ focus: 'strength' })
    expect(profile.usable).toBe(true)
    expect(profile.sampleSize).toBeGreaterThanOrEqual(3)
    expect(profile.preferredBlockWeeks).toBe(4)
    expect(profile.preferredDaysPerWeek).toBe(1)
    expect(profile.preferredRepRange).toBe('4-6')
    expect(profile.typicalStartRpe).toBe(7.5)
    expect(profile.typicalPeakRpe).toBe(9)
    expect(profile.intensityPattern).toBe('rising')
    expect(profile.sourcePrograms.length).toBe(profile.sampleSize)
  })

  it('scopes by focus — peaking is unaffected by strength imports', async () => {
    const profile = await computeStyleProfile({ focus: 'peaking' })
    expect(profile.sampleSize).toBe(0)
  })
})

describe('detectPatterns', () => {
  it('names a pattern shared by ≥3 similar programs, with pre-fill parameters', async () => {
    // The three strength programs committed above all share the linear shape.
    const patterns = await detectPatterns()
    const linear = patterns.find((p) => p.id === 'linear_progression')
    expect(linear).toBeDefined()
    expect(linear!.sampleSize).toBeGreaterThanOrEqual(3)
    expect(linear!.templateId).toBe('strength_linear')
    expect(linear!.goal).toBe('strength')
    expect(linear!.preferredBlockWeeks).toBe(4)
    expect(linear!.preferredDaysPerWeek).toBe(1)
    expect(linear!.typicalStartRpe).toBe(7.5)
    expect(linear!.typicalPeakRpe).toBe(9)
    expect(linear!.sourcePrograms.length).toBe(linear!.sampleSize)
  })

  it('does not surface a pattern below the minimum sample size', async () => {
    // Only two repeated-effort programs → not yet a detected pattern.
    await commit(REPEATED_EFFORT_GRID, 'hypertrophy')
    await commit(REPEATED_EFFORT_GRID, 'hypertrophy')
    let patterns = await detectPatterns()
    expect(patterns.find((p) => p.id === 'repeated_effort')).toBeUndefined()

    // A third one crosses the threshold.
    await commit(REPEATED_EFFORT_GRID, 'hypertrophy')
    patterns = await detectPatterns()
    const repeated = patterns.find((p) => p.id === 'repeated_effort')
    expect(repeated).toBeDefined()
    expect(repeated!.sampleSize).toBe(3)
    expect(repeated!.templateId).toBe('hypertrophy_repeated_effort')
  })
})

describe('intensity ramp — the audit cases', () => {
  const squatWeeks = (loads: number[], extra?: (wk: number) => Cell[][]): Cell[][] => [
    HEADER,
    ...loads.flatMap((load, wk) => [
      [`Week ${wk + 1}`], ['Day 1'], ['Squat', 4, 5, load, 8], ...(extra?.(wk) ?? []),
    ] as Cell[][]),
  ]
  const ramp = async (grid: Cell[][]) =>
    computeFingerprint((await findProgramForExport(await commit(grid, 'strength')))!).intensityRamp

  it('reads a linear block that ends in a deload as rising, not as a wave', async () => {
    expect(await ramp(squatWeeks([100, 105, 110, 115, 90]))).toBe('rising')
  })

  it('ignores accessory loads', async () => {
    // Curls logged in weeks 2 and 4 used to drag those weeks' average down.
    const curls = (wk: number): Cell[][] => (wk === 1 || wk === 3 ? [['Curl', 3, 12, 15, 8]] : [])
    expect(await ramp(squatWeeks([100, 105, 110, 115, 120], curls))).toBe('rising')
  })

  it('still recognises a genuine wave', async () => {
    expect(await ramp(squatWeeks([100, 110, 120, 105, 115, 125]))).toBe('wave')
  })
})

describe('RPE in the fingerprint', () => {
  it('reads the prescribed target, not what the athlete reported', async () => {
    const { createProgram, createWorkout, createExercise, setProgramDuration } = await import('./programService.js')
    const program = await createProgram({ athlete_id: athleteId, name: 'Native', status: 'completed' })
    await setProgramDuration(program.id, '2026-01-05', 2)
    for (const [i, [target, reported]] of [['RPE 7', '9'], ['RPE 8', '9.5']].entries()) {
      const date = i ? '2026-01-12' : '2026-01-05'
      const w = await createWorkout({ program_id: program.id, name: date, scheduled_date: date })
      await createExercise({ workout_id: w.id, name: 'Squat', sets: '4', reps: '5', intensity: target, rpe: reported, load_used: '100' })
    }
    const fp = computeFingerprint((await findProgramForExport(program.id))!)
    expect(fp.startRpe).toBe(7)
    expect(fp.peakRpe).toBe(8)
  })
})
