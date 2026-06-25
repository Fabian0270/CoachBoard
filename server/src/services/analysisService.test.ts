import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  createProgram,
  setProgramDuration,
  createWorkout,
  createExercise,
} from './programService.js'
import { getProgramReport } from './analysisService.js'

beforeAll(async () => {
  await initializeDatabase(':memory:')
})

// Build a one-week program whose single day holds the given exercises, then
// return its computed report.
async function reportFor(
  exercises: Array<{ name: string; intensity?: string | null; rpe?: string | null; reps?: string }>,
) {
  const athlete = await createAthlete({ name: `A-${Math.random()}` })
  const program = await createProgram({ athlete_id: athlete.id, name: 'P' })
  await setProgramDuration(program.id, '2026-01-05', 1) // Monday
  const w = await createWorkout({ program_id: program.id, name: 'Day 1', scheduled_date: '2026-01-05' })
  for (const ex of exercises) {
    await createExercise({
      workout_id: w.id,
      name: ex.name,
      sets: '3',
      reps: ex.reps ?? '5',
      intensity: ex.intensity ?? null,
      load_used: '100',
      rpe: ex.rpe ?? null,
    })
  }
  const report = await getProgramReport(program.id)
  if (!report) throw new Error('no report')
  return report
}

describe('getProgramReport — avg RPE deviation', () => {
  it('parses a bare-number prescribed RPE from the intensity field', async () => {
    // intensity "8" (no "RPE" prefix), athlete reported 9 → delta +1
    const report = await reportFor([{ name: 'Squat', intensity: '8', rpe: '9' }])
    expect(report.rpeDeviations[0].prescribedRpe).toBe(8)
    expect(report.rpeDeviations[0].delta).toBe(1)
    expect(report.avgRpeDeviation).toBe(1)
  })

  it('parses explicit-marker and range prescribed RPE', async () => {
    const report = await reportFor([
      { name: 'Squat', intensity: 'RPE 8', rpe: '8' }, // delta 0
      { name: 'Bench', intensity: '@7', rpe: '8' },    // delta +1
      { name: 'Deadlift', intensity: '8-9', rpe: '8.5' }, // prescribed midpoint 8.5, delta 0
    ])
    const byName = Object.fromEntries(report.rpeDeviations.map((r) => [r.exerciseName, r]))
    expect(byName.Squat.delta).toBe(0)
    expect(byName.Bench.prescribedRpe).toBe(7)
    expect(byName.Bench.delta).toBe(1)
    expect(byName.Deadlift.prescribedRpe).toBe(8.5)
    expect(byName.Deadlift.delta).toBe(0)
    // avg over the three deltas (0 + 1 + 0) / 3
    expect(report.avgRpeDeviation).toBeCloseTo(0.33, 2)
  })

  it('treats a bare percentage as a load target, not an RPE', async () => {
    const report = await reportFor([{ name: 'Squat', intensity: '70%', rpe: '8' }])
    expect(report.rpeDeviations[0].prescribedRpe).toBeNull()
    expect(report.rpeDeviations[0].delta).toBeNull()
    expect(report.avgRpeDeviation).toBeNull()
  })

  it('only reports exercises where the actual RPE is filled in', async () => {
    const report = await reportFor([
      { name: 'Squat', intensity: '8', rpe: '9' }, // counted
      { name: 'Bench', intensity: '8', rpe: null }, // no actual RPE → excluded entirely
    ])
    expect(report.rpeDeviations).toHaveLength(1)
    expect(report.rpeDeviations[0].exerciseName).toBe('Squat')
    expect(report.avgRpeDeviation).toBe(1)
  })
})
