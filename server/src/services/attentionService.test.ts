import { beforeEach, describe, it, expect } from 'vitest'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import { createProgram, setProgramDuration, createWorkout, createExercise } from './programService.js'
import { needsAttention } from './attentionService.js'

// The dashboard's "needs attention" list (I2). Today is Monday 16 November 2026.
const TODAY = '2026-11-16'

beforeEach(async () => {
  await initializeDatabase(':memory:')
})

async function block(athleteId: string, name: string, start: string, weeks: number, status = 'active') {
  const p = await createProgram({ athlete_id: athleteId, name, status })
  await setProgramDuration(p.id, start, weeks)
  return p.id
}
async function trainingDay(programId: string, date: string, logged: boolean) {
  const w = await createWorkout({ program_id: programId, name: date, scheduled_date: date })
  await createExercise({ workout_id: w.id, name: 'Squat', sets: '3', reps: '5', order_index: 0, ...(logged ? { load_used: '140', rpe: '8' } : {}) })
}
const kinds = async () => (await needsAttention(TODAY)).map((i) => [i.kind, i.athleteName, i.programName, i.date, i.count])

describe('needsAttention', () => {
  it('a block ending within a week with no next program', async () => {
    const anna = (await createAthlete({ name: 'Anna' })).id
    // 26 Oct + 4 weeks ends Sunday 22 Nov.
    await block(anna, 'Autumn Block', '2026-10-26', 4)
    expect(await kinds()).toEqual([['block-ending', 'Anna', 'Autumn Block', '2026-11-22', null]])
  })

  it('…not once the next block exists, a draft included', async () => {
    const anna = (await createAthlete({ name: 'Anna' })).id
    await block(anna, 'Autumn Block', '2026-10-26', 4)
    await block(anna, 'Winter Block', '2026-11-23', 4, 'draft')
    expect(await kinds()).toEqual([])
  })

  it('…and not for a block ending later than a week from now', async () => {
    const anna = (await createAthlete({ name: 'Anna' })).id
    await block(anna, 'Long Block', '2026-11-02', 6)
    expect(await kinds()).toEqual([])
  })

  it('a block already past its end and still active is flagged too', async () => {
    const anna = (await createAthlete({ name: 'Anna' })).id
    await block(anna, 'Old Block', '2026-09-28', 4)
    expect((await kinds())[0]).toEqual(['block-ending', 'Anna', 'Old Block', '2026-10-25', null])
  })

  it('training days a week or more ago with nothing logged; a weekly import never trips it', async () => {
    const erik = (await createAthlete({ name: 'Erik' })).id
    const p = await block(erik, 'Strength', '2026-10-19', 8)
    await trainingDay(p, '2026-10-26', true)    // logged
    await trainingDay(p, '2026-11-02', false)   // 14 days ago, nothing
    await trainingDay(p, '2026-11-09', false)   // exactly 7 days ago, nothing
    await trainingDay(p, '2026-11-12', false)   // 4 days ago: not yet expected
    expect(await kinds()).toEqual([['no-results', 'Erik', 'Strength', '2026-11-09', 2]])
  })

  it('an empty day (no exercises) is not a training day', async () => {
    const erik = (await createAthlete({ name: 'Erik' })).id
    const p = await block(erik, 'Strength', '2026-10-19', 8)
    await createWorkout({ program_id: p, name: 'rest', scheduled_date: '2026-11-02' })
    expect(await kinds()).toEqual([])
  })

  it('an athlete on the roster with no active program; archived athletes are left out', async () => {
    await createAthlete({ name: 'Lisa' })
    const old = (await createAthlete({ name: 'Gone' })).id
    await getDb().updateTable('athletes').set({ archived: 1 }).where('id', '=', old).execute()
    const done = (await createAthlete({ name: 'Maja' })).id
    await block(done, 'Finished', '2026-09-28', 4, 'completed')
    expect(await kinds()).toEqual([
      ['no-program', 'Lisa', null, null, null],
      ['no-program', 'Maja', null, null, null],
    ])
  })

  it('lists block endings first, then missing results, then athletes without a program', async () => {
    const a = (await createAthlete({ name: 'Anna' })).id
    const e = (await createAthlete({ name: 'Erik' })).id
    await createAthlete({ name: 'Lisa' })
    await block(a, 'Autumn Block', '2026-10-26', 4)
    const p = await block(e, 'Strength', '2026-10-19', 8)
    await trainingDay(p, '2026-11-02', false)
    expect((await kinds()).map((k) => k[0])).toEqual(['block-ending', 'no-results', 'no-program'])
  })
})
