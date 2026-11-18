import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { createAthlete, createAthleteMax } from './athleteService.js'
import { getDefaultUnit, setDefaultUnit, numericLoad, switchAthleteUnit, unitImpact } from './unitService.js'
import { roundToPlates, convertLoad } from 'coachboard-shared/units'
import { duplicateProgram } from './program/duplicateProgram.js'
import { buildProgramWorkbook } from './programExport.js'
import ExcelJS from 'exceljs'

// S3 (D76–D78): kg or lb per athlete, the Settings default, and switching.

let tmpDir: string
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-unit-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})
afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const now = () => new Date().toISOString()

async function athleteWithData(unit: 'kg' | 'lb' = 'kg') {
  const db = getDb()
  const a = await createAthlete({ name: 'Ada', unit })
  const programId = uuidv4()
  const workoutId = uuidv4()
  await db.insertInto('programs').values({
    id: programId, athlete_id: a.id, name: 'Block', description: null, start_date: '2026-11-16', end_date: '2026-11-22',
    status: 'active', created_at: now(), updated_at: now(), enabled_columns: null, focus: null, export_layout: null,
    export_template_sha: null, builtin_template: 'coachboard',
  }).execute()
  await db.insertInto('workouts').values({ id: workoutId, program_id: programId, name: 'Day', scheduled_date: '2026-11-17', completed_at: null, notes: null, created_at: now() }).execute()
  const ex = (name: string, weight: number | null, load_used: string | null, intensity: string | null = null) => db.insertInto('exercises').values({
    id: uuidv4(), workout_id: workoutId, name, sets: '3', reps: '3', weight, duration: null, distance: null, notes: null, order_index: 0,
    rest_time: null, intensity, load_used, rpe: null, group_id: null, suggestion_note: null,
  }).execute()
  await ex('Squat', 180, '182,5')
  await ex('Bench', null, 'BW+20', 'RPE 8 @100')
  await ex('Row', 60, null)
  await db.insertInto('athlete_maxes').values({ id: uuidv4(), athlete_id: a.id, lift_name: 'Squat', weight: 200, unit: 'kg', recorded_at: '2026-11-01', notes: null }).execute()
  await db.insertInto('video_analyses').values({
    id: uuidv4(), media_id: null, athlete_id: a.id, source_label: '', track: '[]', calibration: null, metrics: '[]', notes: null,
    lift: 'back-squat', load_kg: 140, called_rpe: null, metric: null, video_path: null, video_bytes: null, created_at: now(), updated_at: now(),
  }).execute()
  return a.id
}

describe('the default unit', () => {
  it('is kg until changed, and new athletes start on it', async () => {
    expect(await getDefaultUnit()).toBe('kg')
    expect((await createAthlete({ name: 'A' })).unit).toBe('kg')
    await setDefaultUnit('lb')
    expect(await getDefaultUnit()).toBe('lb')
    expect((await createAthlete({ name: 'B' })).unit).toBe('lb')
    expect((await createAthlete({ name: 'C', unit: 'kg' })).unit).toBe('kg')
  })
})

describe('duplicating to an athlete in the other unit', () => {
  it('converts the loads to their unit, rounded to their plates, and scales by maxes in it', async () => {
    const kgId = await athleteWithData('kg')
    const source = await getDb().selectFrom('programs').select('id').where('athlete_id', '=', kgId).executeTakeFirstOrThrow()
    const lb = await createAthlete({ name: 'Lb', unit: 'lb' })
    const plain = await duplicateProgram(source.id, { athleteId: lb.id, name: 'Copy', startDate: '2026-12-07', keepResults: true, scaleLoads: false })
    const rows = (id: string) => getDb().selectFrom('exercises').innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name', 'exercises.weight', 'exercises.load_used']).where('workouts.program_id', '=', id).orderBy('exercises.name').execute()
    expect(await rows(plain!.id)).toEqual([
      { name: 'Bench', weight: null, load_used: 'BW+20' },
      { name: 'Row', weight: 130, load_used: null },
      { name: 'Squat', weight: 395, load_used: '400' },
    ])
    // The kg athlete's squat max is 200 kg; the lb athlete's 500 lb (~227 kg).
    await createAthleteMax({ athlete_id: lb.id, lift_name: 'Squat', weight: 500 })
    const scaled = await duplicateProgram(source.id, { athleteId: lb.id, name: 'Scaled', startDate: '2026-12-07', keepResults: false, scaleLoads: true })
    // 180 kg is 90 % of 200 kg; 90 % of 500 lb is 450 lb.
    expect((await rows(scaled!.id)).find((r) => r.name === 'Squat')?.weight).toBe(450)
  })
})

describe('the exported sheet', () => {
  it("names the athlete's unit on a Modern card", async () => {
    const id = await athleteWithData('lb')
    const program = await getDb().selectFrom('programs').select('id').where('athlete_id', '=', id).executeTakeFirstOrThrow()
    await getDb().updateTable('programs').set({ builtin_template: 'modern' }).where('id', '=', program.id).execute()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await buildProgramWorkbook(program.id)).buffer as unknown as ArrayBuffer)
    const cells: string[] = []
    wb.worksheets[0].eachRow((row) => row.eachCell((c) => { cells.push(typeof c.value === 'string' ? c.value : JSON.stringify(c.value)) }))
    expect(cells.some((t) => t.includes('180 lb') && t.includes('→ 182,5 lb'))).toBe(true)
    expect(cells.some((t) => /\bkg\b/.test(t))).toBe(false)
  })
})

describe('a new max', () => {
  it("is in the athlete's unit unless one is given", async () => {
    const lb = await createAthlete({ name: 'Lb', unit: 'lb' })
    expect((await createAthleteMax({ athlete_id: lb.id, lift_name: 'Squat', weight: 405 })).unit).toBe('lb')
    expect((await createAthleteMax({ athlete_id: lb.id, lift_name: 'Squat', weight: 180, unit: 'kg' })).unit).toBe('kg')
    const kg = await createAthlete({ name: 'Kg' })
    expect((await createAthleteMax({ athlete_id: kg.id, lift_name: 'Squat', weight: 180 })).unit).toBe('kg')
  })
})

describe('numericLoad', () => {
  it('only a plain number counts', () => {
    expect(numericLoad('140')).toBe(140)
    expect(numericLoad(' 102,5 kg')).toBe(102.5)
    expect(numericLoad('BW+20')).toBeNull()
    expect(numericLoad('140x3')).toBeNull()
    expect(numericLoad(null)).toBeNull()
  })
})

describe('switching an athlete', () => {
  it('counts what would be converted', async () => {
    const id = await athleteWithData()
    expect(await unitImpact(id)).toEqual({ loadCaps: 2, loadsUsed: 1, maxes: 1, barPathSets: 1 })
  })

  it('converts every number to the plates of the new unit, and leaves text alone', async () => {
    const id = await athleteWithData()
    expect(await switchAthleteUnit(id, 'lb', true)).toEqual({ unit: 'lb', converted: true })
    const db = getDb()
    const rows = await db.selectFrom('exercises').select(['name', 'weight', 'load_used', 'intensity']).orderBy('name').execute()
    expect(rows).toEqual([
      { name: 'Bench', weight: null, load_used: 'BW+20', intensity: 'RPE 8 @100' },
      { name: 'Row', weight: 130, load_used: null, intensity: null },
      { name: 'Squat', weight: 395, load_used: '400', intensity: null },
    ])
    expect(await db.selectFrom('athlete_maxes').select(['weight', 'unit']).execute()).toEqual([{ weight: 440, unit: 'lb' }])
    expect((await db.selectFrom('video_analyses').select('load_kg').executeTakeFirstOrThrow()).load_kg).toBe(310)
    expect((await db.selectFrom('athletes').select('unit').where('id', '=', id).executeTakeFirstOrThrow()).unit).toBe('lb')
  })

  it('back again lands on kg plates', async () => {
    const id = await athleteWithData()
    await switchAthleteUnit(id, 'lb', true)
    await switchAthleteUnit(id, 'kg', true)
    const squat = await getDb().selectFrom('exercises').select('weight').where('name', '=', 'Squat').executeTakeFirstOrThrow()
    expect(squat.weight).toBe(roundToPlates(convertLoad(395, 'lb', 'kg'), 'kg'))
    expect(squat.weight).toBe(180)
  })

  it('without converting, only the unit changes', async () => {
    const id = await athleteWithData()
    expect(await switchAthleteUnit(id, 'lb', false)).toEqual({ unit: 'lb', converted: false })
    const squat = await getDb().selectFrom('exercises').select(['weight', 'load_used']).where('name', '=', 'Squat').executeTakeFirstOrThrow()
    expect(squat).toEqual({ weight: 180, load_used: '182,5' })
  })

  it('nothing to do for the same unit, nothing for no athlete', async () => {
    const id = await athleteWithData('lb')
    expect(await switchAthleteUnit(id, 'lb', true)).toEqual({ unit: 'lb', converted: false })
    expect(await switchAthleteUnit('nobody', 'kg', true)).toBeNull()
  })
})
