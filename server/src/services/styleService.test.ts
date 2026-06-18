import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import { findProgramForExport } from './programService.js'
import { parseExternalFile, commitExternalProgram } from './externalImportService.js'
import { computeFingerprint, computeStyleProfile } from './styleService.js'
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
const STRENGTH_GRID: Cell[][] = [
  HEADER,
  ['Week 1'], ['Day 1'], ['Squat', 4, 5, 100, 7.5],
  ['Week 2'], ['Day 1'], ['Squat', 4, 5, 105, 8],
  ['Week 3'], ['Day 1'], ['Squat', 4, 4, 110, 8.5],
  ['Week 4'], ['Day 1'], ['Squat', 4, 3, 115, 9],
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
