import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  createProgram,
  createWorkout,
  createExercise,
  findProgramById,
  setProgramDuration,
  DurationWouldRemoveDays,
} from './programService.js'

// ---------------------------------------------------------------------------
// Changing when a program starts and how long it runs.
//
// Measured before this was fixed: the duration endpoint changed the program's
// two dates and nothing else. Postponing a block a week left every training day
// on its old calendar date, and shortening one left the later weeks' days
// stored but never shown.
// ---------------------------------------------------------------------------

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Test Athlete' })).id
})

/** A 4-week block from Monday 2026-06-08 with a Monday session in every week. */
const block = async (name: string, resultsInWeek?: number) => {
  const p = await createProgram({ athlete_id: athleteId, name })
  await setProgramDuration(p.id, '2026-06-08', 4)
  const mondays = ['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29']
  for (const [i, date] of mondays.entries()) {
    const w = await createWorkout({ program_id: p.id, name: date, scheduled_date: date })
    await createExercise({
      workout_id: w.id, name: 'Squat', sets: '5', reps: '5', order_index: 0,
      ...(resultsInWeek === i ? { load_used: '140', rpe: '8' } : {}),
    })
  }
  return p
}

const dates = async (programId: string) =>
  (await findProgramById(programId))!.workouts.map((w) => w.scheduled_date).sort()

describe('setProgramDuration — the training days travel with the start date', () => {
  it('moves every training day when the block starts a week later', async () => {
    const p = await block('Postponed')
    const updated = await setProgramDuration(p.id, '2026-06-15', 4)
    expect(updated?.start_date).toBe('2026-06-15')
    expect(await dates(p.id)).toEqual(['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06'])
  })

  it('moves them back when it starts earlier, and keeps a day named after its date in step', async () => {
    const p = await block('Brought forward')
    await setProgramDuration(p.id, '2026-06-01', 4)
    const program = await findProgramById(p.id)
    expect(program!.workouts.map((w) => w.scheduled_date).sort()).toEqual(
      ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'],
    )
    expect(program!.workouts.every((w) => w.name === w.scheduled_date)).toBe(true)
  })

  it('leaves the days alone when only the length changes', async () => {
    const p = await block('Longer')
    await setProgramDuration(p.id, '2026-06-08', 6)
    expect(await dates(p.id)).toEqual(['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29'])
  })

  it('treats any day of the same week as the same start, as the calendar does', async () => {
    const p = await block('Same week')
    // Wednesday of the week the block already starts in.
    await setProgramDuration(p.id, '2026-06-10', 4)
    expect(await dates(p.id)).toEqual(['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29'])
  })
})

describe('setProgramDuration — shortening', () => {
  it('refuses to drop training days unless told it may, and changes nothing', async () => {
    const p = await block('Shorter', 3)
    const err = await setProgramDuration(p.id, '2026-06-08', 2).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DurationWouldRemoveDays)
    expect((err as DurationWouldRemoveDays).days).toBe(2)
    // Week 4 is the one the athlete has trained.
    expect((err as DurationWouldRemoveDays).daysWithResults).toBe(1)

    const program = await findProgramById(p.id)
    expect(program!.end_date).toBe('2026-07-05')
    expect(program!.workouts).toHaveLength(4)
  })

  it('removes the days that fall outside once the coach has agreed', async () => {
    const p = await block('Shorter, agreed')
    const updated = await setProgramDuration(p.id, '2026-06-08', 2, true)
    expect(updated?.end_date).toBe('2026-06-21')
    expect(await dates(p.id)).toEqual(['2026-06-08', '2026-06-15'])
  })

  it('counts what falls outside AFTER the move, not before', async () => {
    const p = await block('Moved and shortened')
    // One week later and one week shorter: the last session lands on 6 July,
    // a day past the new end. Counted before the move it would have been none.
    const err = await setProgramDuration(p.id, '2026-06-15', 3).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DurationWouldRemoveDays)
    expect((err as DurationWouldRemoveDays).days).toBe(1)

    await setProgramDuration(p.id, '2026-06-15', 3, true)
    expect(await dates(p.id)).toEqual(['2026-06-15', '2026-06-22', '2026-06-29'])
  })
})
