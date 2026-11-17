import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { logCandidates, logCaption, repsDone, formatLoad, CaptionLogError } from './captionLogService.js'
import { setMediaWorkout } from './discordMediaService.js'
import { getAthleteProgress } from './athleteProgressService.js'
import { computeE1RMTrends } from './analysisService.js'
import { updateExercise } from './program/exerciseService.js'
import { duplicateProgram } from './program/duplicateProgram.js'

// L1 (D10, D66): a caption's result logged on a row, only when the coach asks,
// never over something already logged, with differing reps kept apart.

let tmpDir: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-caplog-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})

afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const now = () => new Date().toISOString()

type Row = { name: string; reps?: string; weight?: number | null; load_used?: string | null; rpe?: string | null }

async function day(rows: Row[]) {
  const db = getDb()
  const athleteId = uuidv4()
  const programId = uuidv4()
  const workoutId = uuidv4()
  await db.insertInto('athletes').values({
    id: athleteId, name: 'Ada', email: null, sport: null, date_of_birth: null,
    notes: null, archived: 0, created_at: now(), updated_at: now(),
  }).execute()
  await db.insertInto('programs').values({
    id: programId, athlete_id: athleteId, name: 'Block', description: null,
    start_date: '2026-11-16', end_date: '2026-12-13', status: 'active', created_at: now(), updated_at: now(),
    enabled_columns: null, focus: null, export_layout: null, export_template_sha: null,
    builtin_template: 'coachboard',
  }).execute()
  await db.insertInto('workouts').values({
    id: workoutId, program_id: programId, name: 'Day 1',
    scheduled_date: '2026-11-17', completed_at: null, notes: null, created_at: now(),
  }).execute()
  const ids: string[] = []
  for (const [i, r] of rows.entries()) {
    const id = uuidv4()
    ids.push(id)
    await db.insertInto('exercises').values({
      id, workout_id: workoutId, name: r.name, sets: '1', reps: r.reps ?? '3',
      weight: r.weight ?? null, duration: null, distance: null, notes: 'brace hard', order_index: i,
      rest_time: null, intensity: null, load_used: r.load_used ?? null, rpe: r.rpe ?? null, group_id: null,
      suggestion_note: null,
    }).execute()
  }
  return { athleteId, programId, workoutId, ids }
}

async function media(caption: string | null, workoutId: string | null = null) {
  const db = getDb()
  await db.insertInto('discord_users').values({
    id: 'u1', username: 'ada', display_name: null, avatar_url: null,
    athlete_id: null, linked_at: null, first_seen_at: now(),
  }).onConflict((oc) => oc.column('id').doNothing()).execute()
  const id = uuidv4()
  await db.insertInto('discord_media').values({
    id, channel_id: 'c1', channel_name: '#form-checks',
    message_id: `m-${id}`, attachment_id: `a-${id}`, discord_user_id: 'u1',
    athlete_id: null, workout_id: workoutId, suggested_workout_id: null,
    filename: 'video.mp4', content_type: 'video/mp4', size_bytes: 100, width: null, height: null,
    message_content: caption,
    posted_at: '2026-11-17T10:00:00.000Z', posted_date: '2026-11-17',
    source_url: null, local_path: null, sha256: null,
    download_status: 'pending', download_error: null, duplicate_of_id: null,
    reviewed: 0, created_at: now(),
  }).execute()
  return id
}

const row = (id: string) => getDb().selectFrom('exercises').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

describe('repsDone / formatLoad', () => {
  it('stores reps only when they differ from the plan', () => {
    expect(repsDone('3', 3)).toBeNull()
    expect(repsDone(' 3 ', 3)).toBeNull()
    expect(repsDone('5', 3)).toBe('3')
    expect(repsDone('3-5', 4)).toBe('4')
    expect(repsDone(null, 2)).toBe('2')
    expect(repsDone('5', null)).toBeNull()
  })
  it('writes loads the way a coach types them', () => {
    expect(formatLoad(180)).toBe('180')
    expect(formatLoad(182.5)).toBe('182.5')
    expect(formatLoad(81.64662)).toBe('81.6')
  })
})

describe('logCandidates', () => {
  it('marks the row of the named lift at the caption load as fitting', async () => {
    const d = await day([
      { name: 'Squat', weight: 180 },
      { name: 'Pause Squat', weight: 140 },
      { name: 'Bench', weight: 100 },
    ])
    const m = await media('squat 180x3 @8')
    const c = await logCandidates(m, d.workoutId)
    expect(c.caption).toMatchObject({ weightKg: 180, reps: 3, rpe: 8 })
    expect(c.rows.filter((r) => r.fits).map((r) => r.name)).toEqual(['Squat'])
  })

  it('every row of the lift fits when no load agrees', async () => {
    const d = await day([{ name: 'Squat' }, { name: 'Squat', weight: 150 }, { name: 'Bench' }])
    const m = await media('squat 190x1')
    const c = await logCandidates(m, d.workoutId)
    expect(c.rows.filter((r) => r.fits)).toHaveLength(2)
  })

  it('without a lift named, the load alone decides', async () => {
    const d = await day([{ name: 'Squat', weight: 180 }, { name: 'Bench', weight: 100 }])
    const m = await media('100x5')
    const c = await logCandidates(m, d.workoutId)
    expect(c.rows.filter((r) => r.fits).map((r) => r.name)).toEqual(['Bench'])
  })

  it('flags rows already logged', async () => {
    const d = await day([{ name: 'Squat', weight: 180, load_used: '175' }, { name: 'Squat', weight: 180, rpe: '8' }])
    const m = await media('squat 180x3')
    const c = await logCandidates(m, d.workoutId)
    expect(c.rows.map((r) => r.alreadyLogged)).toEqual([true, true])
  })
})

describe('logCaption', () => {
  it('writes load and RPE, and keeps the planned reps and the cue untouched', async () => {
    const d = await day([{ name: 'Squat', reps: '3', weight: 180 }])
    const m = await media('squat 180x3 @8.5', d.workoutId)
    await logCaption(m, d.ids[0])
    const r = await row(d.ids[0])
    expect(r).toMatchObject({ load_used: '180', rpe: '8.5', reps: '3', reps_done: null, notes: 'brace hard' })
  })

  it('stores differing reps as done, not in the plan or the note', async () => {
    const d = await day([{ name: 'Squat', reps: '5', weight: 180 }])
    const m = await media('squat 180x3 @9', d.workoutId)
    await logCaption(m, d.ids[0])
    const r = await row(d.ids[0])
    expect(r).toMatchObject({ load_used: '180', rpe: '9', reps: '5', reps_done: '3', notes: 'brace hard' })
  })

  it('leaves RPE empty when the caption has none', async () => {
    const d = await day([{ name: 'Squat', reps: '3' }])
    const m = await media('180x3', d.workoutId)
    await logCaption(m, d.ids[0])
    expect(await row(d.ids[0])).toMatchObject({ load_used: '180', rpe: null })
  })

  it('never overwrites a logged row', async () => {
    const d = await day([{ name: 'Squat', load_used: '175', rpe: '8' }, { name: 'Squat', rpe: '7' }])
    const m = await media('squat 180x3 @8', d.workoutId)
    await expect(logCaption(m, d.ids[0])).rejects.toMatchObject({ status: 409, message: 'Already logged: 175 @8' })
    await expect(logCaption(m, d.ids[1])).rejects.toBeInstanceOf(CaptionLogError)
    expect(await row(d.ids[0])).toMatchObject({ load_used: '175', rpe: '8' })
    expect(await row(d.ids[1])).toMatchObject({ load_used: null, rpe: '7' })
  })

  it('refuses a row on a day the video is not attached to', async () => {
    const d = await day([{ name: 'Squat' }])
    const m = await media('squat 180x3')
    await expect(logCaption(m, d.ids[0])).rejects.toMatchObject({ status: 409 })
    await setMediaWorkout(m, d.workoutId)
    await logCaption(m, d.ids[0])
    expect((await row(d.ids[0])).load_used).toBe('180')
  })

  it('refuses a caption without a load', async () => {
    const d = await day([{ name: 'Squat' }])
    const m = await media('felt heavy', d.workoutId)
    await expect(logCaption(m, d.ids[0])).rejects.toMatchObject({ status: 400 })
  })
})

describe('reps done downstream', () => {
  it('the e1RM uses the reps done', async () => {
    const d = await day([{ name: 'Squat', reps: '5', weight: 180 }])
    const m = await media('squat 180x1 @10', d.workoutId)
    await logCaption(m, d.ids[0])
    const progress = await getAthleteProgress(d.athleteId)
    expect(progress!.e1rm[0].points[0]).toMatchObject({ reps: 1, e1rm: 180 })
    const trends = computeE1RMTrends([await row(d.ids[0])], new Map())
    expect([...trends.get('squat')!.pointsMap.values()][0]).toMatchObject({ reps: 1, e1rm: 180 })
  })

  it('typing a new Load Used clears it', async () => {
    const d = await day([{ name: 'Squat', reps: '5' }])
    const m = await media('squat 180x3 @9', d.workoutId)
    await logCaption(m, d.ids[0])
    await updateExercise(d.ids[0], d.workoutId, { load_used: '170' })
    expect(await row(d.ids[0])).toMatchObject({ load_used: '170', reps_done: null })
  })

  it('typing an RPE keeps it', async () => {
    const d = await day([{ name: 'Squat', reps: '5' }])
    const m = await media('squat 180x3', d.workoutId)
    await logCaption(m, d.ids[0])
    await updateExercise(d.ids[0], d.workoutId, { rpe: '9' })
    expect(await row(d.ids[0])).toMatchObject({ load_used: '180', rpe: '9', reps_done: '3' })
  })

  it('duplicating with results carries it; without, it does not', async () => {
    const d = await day([{ name: 'Squat', reps: '5' }])
    const m = await media('squat 180x3 @9', d.workoutId)
    await logCaption(m, d.ids[0])
    const base = { athleteId: d.athleteId, name: 'Copy', startDate: '2026-12-14', scaleLoads: false }
    const kept = await duplicateProgram(d.programId, { ...base, keepResults: true })
    const plain = await duplicateProgram(d.programId, { ...base, keepResults: false })
    const of = (programId: string) => getDb().selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select('exercises.reps_done').where('workouts.program_id', '=', programId).executeTakeFirstOrThrow()
    expect((await of(kept!.id)).reps_done).toBe('3')
    expect((await of(plain!.id)).reps_done).toBeNull()
  })
})
