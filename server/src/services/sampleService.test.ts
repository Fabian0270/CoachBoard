import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { createAthlete } from './athleteService.js'
import { createPayment, getPaymentAlerts } from './paymentService.js'
import { loadSampleAthlete, removeSampleAthlete, sampleStatus, SAMPLE_NAME } from './sampleService.js'
import { needsAttention } from './attentionService.js'
import { revenueSummary, paymentsCsv } from './revenueService.js'
import { computeStyleProfile } from './styleService.js'
import { configureRatesFetcher, homeCurrency } from './ratesService.js'

// T7 (D9, D15, D111): the tour's sample athlete.

vi.spyOn(console, 'log').mockImplementation(() => {})

let dir = ''
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-sample-'))
  configureSecureStore({ safeStorage: null, userDataDir: dir })
  configureRatesFetcher(async () => { throw new Error('offline') })
  await initializeDatabase(path.join(dir, 'coachboard.sqlite'))
})
afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows lock */ }
})

const TODAY = '2026-11-19' // a Thursday

describe('the sample athlete', () => {
  it('a finished block with results, a draft starting next Monday, maxes and a payment', async () => {
    const { athleteId } = await loadSampleAthlete(TODAY)
    const db = getDb()
    const athlete = await db.selectFrom('athletes').selectAll().where('id', '=', athleteId!).executeTakeFirstOrThrow()
    expect(athlete).toMatchObject({ name: SAMPLE_NAME, is_sample: 1, unit: 'kg', archived: 0 })
    const maxes = await db.selectFrom('athlete_maxes').select(['lift_name', 'weight']).where('athlete_id', '=', athleteId!).orderBy('lift_name').execute()
    expect(maxes.map((m) => m.lift_name)).toEqual(['Bench Press', 'Deadlift', 'Squat'])

    const programs = await db.selectFrom('programs').selectAll().where('athlete_id', '=', athleteId!).orderBy('start_date').execute()
    expect(programs.map((p) => [p.status, p.start_date, p.end_date])).toEqual([
      ['completed', '2026-10-19', '2026-11-15'], // ended last Sunday
      ['draft', '2026-11-23', '2026-12-20'],     // starts next Monday
    ])
    const rows = async (programId: string) => db.selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name', 'exercises.weight', 'exercises.load_used', 'exercises.rpe', 'exercises.suggestion_note', 'workouts.scheduled_date'])
      .where('workouts.program_id', '=', programId).execute()
    const done = await rows(programs[0].id)
    const draft = await rows(programs[1].id)
    expect(new Set(done.map((r) => r.scheduled_date)).size).toBe(12) // 3 days x 4 weeks
    expect(done.every((r) => r.load_used !== null && r.rpe !== null)).toBe(true)
    expect(draft.every((r) => r.load_used === null && r.rpe === null)).toBe(true)
    expect(draft.some((r) => r.suggestion_note)).toBe(true)
    // Loads on the plates, and the draft a little heavier than the block before.
    expect(done.every((r) => r.weight === null || (r.weight * 2) % 5 === 0)).toBe(true)
    const topSquat = (list: typeof done) => Math.max(...list.filter((r) => r.name === 'Squat').map((r) => r.weight ?? 0))
    expect(topSquat(draft)).toBeGreaterThan(topSquat(done))

    const payments = await db.selectFrom('payments').selectAll().where('athlete_id', '=', athleteId!).execute()
    expect(payments).toHaveLength(1)
  })

  it('loading twice keeps one sample', async () => {
    const a = await loadSampleAthlete(TODAY)
    const b = await loadSampleAthlete(TODAY)
    expect(b.athleteId).toBe(a.athleteId)
    expect((await getDb().selectFrom('athletes').select('id').where('is_sample', '=', 1).execute())).toHaveLength(1)
  })

  it('stays out of the coach’s own numbers', async () => {
    const real = await createAthlete({ name: 'Real Athlete', unit: 'kg' })
    await createPayment({ athlete_id: real.id, amount: 1200, currency: 'SEK', start_date: '2026-11-01', paid_through: '2026-11-22', paid: true, paid_at: '2026-11-01' })
    await loadSampleAthlete(TODAY)
    // Needs attention: the real athlete (no program) shows; the sample never does.
    const attention = await needsAttention(TODAY)
    expect(attention.some((a) => JSON.stringify(a).includes('Real Athlete'))).toBe(true)
    expect(attention.some((a) => JSON.stringify(a).includes(SAMPLE_NAME))).toBe(false)
    // Payment reminders, revenue, the CSV and the currency guess: the real payment only.
    expect((await getPaymentAlerts(TODAY)).map((a) => a.athleteName)).toEqual(['Real Athlete'])
    const s = await revenueSummary({ today: TODAY, now: new Date(`${TODAY}T12:00:00Z`) })
    expect(Object.keys(s.months.at(-1)!.byCurrency)).toEqual(['SEK'])
    expect(await paymentsCsv()).not.toContain(SAMPLE_NAME)
    expect(await homeCurrency()).toBe('SEK')
    // The learned style: the sample's finished block is not the coach's programming.
    expect((await computeStyleProfile()).sourcePrograms.map((p) => p.name)).not.toContain('Strength Block 1')
  })

  it('removing it takes everything it owns, and nothing of anyone else’s', async () => {
    const real = await createAthlete({ name: 'Real Athlete', unit: 'kg' })
    const { athleteId } = await loadSampleAthlete(TODAY)
    expect((await sampleStatus()).loaded).toBe(true)
    await removeSampleAthlete()
    const db = getDb()
    expect(await sampleStatus()).toEqual({ loaded: false, athleteId: null })
    for (const table of ['programs', 'athlete_maxes', 'payments'] as const) {
      expect(await db.selectFrom(table).select('id').where('athlete_id', '=', athleteId!).execute()).toHaveLength(0)
    }
    expect(await db.selectFrom('workouts').select('id').execute()).toHaveLength(0)
    expect(await db.selectFrom('exercises').select('id').execute()).toHaveLength(0)
    expect(await db.selectFrom('athletes').select('name').execute()).toEqual([{ name: real.name }])
  })
})
