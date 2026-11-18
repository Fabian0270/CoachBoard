import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { sql } from 'kysely'
import { v4 as uuidv4 } from 'uuid'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { createApp } from '../app.js'
import { rowsFittingSet, soleFit, linkCandidates, linkProblem } from './analysisLinkService.js'
import { saveAnalysis, getAnalysis, updateAnalysisContext } from './videoAnalysisService.js'
import type { SaveVideoAnalysisInput } from 'coachboard-shared/videoAnalysis'

// L2 (D67, D70): a saved set linked to the training day and row it was.

let tmpDir: string
let dbPath: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-link-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  dbPath = path.join(tmpDir, 'test.sqlite')
  await initializeDatabase(dbPath)
})

afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const now = () => new Date().toISOString()

async function athlete(name = 'Ada') {
  const id = uuidv4()
  await getDb().insertInto('athletes').values({
    id, name, email: null, sport: null, date_of_birth: null, notes: null, archived: 0, created_at: now(), updated_at: now(),
  }).execute()
  return id
}

type Row = { name: string; weight?: number | null; load_used?: string | null }

async function day(athleteId: string, date: string, rows: Row[], workoutName = 'Heavy day') {
  const db = getDb()
  let program = await db.selectFrom('programs').select('id').where('athlete_id', '=', athleteId).executeTakeFirst()
  if (!program) {
    program = { id: uuidv4() }
    await db.insertInto('programs').values({
      id: program.id, athlete_id: athleteId, name: 'Block', description: null, start_date: '2026-11-16', end_date: '2026-12-13',
      status: 'active', created_at: now(), updated_at: now(), enabled_columns: null, focus: null, export_layout: null,
      export_template_sha: null, builtin_template: 'coachboard',
    }).execute()
  }
  const workoutId = uuidv4()
  await db.insertInto('workouts').values({
    id: workoutId, program_id: program.id, name: workoutName, scheduled_date: date, completed_at: null, notes: null, created_at: now(),
  }).execute()
  const ids: string[] = []
  for (const [i, r] of rows.entries()) {
    const id = uuidv4()
    ids.push(id)
    await db.insertInto('exercises').values({
      id, workout_id: workoutId, name: r.name, sets: '3', reps: '3', weight: r.weight ?? null, duration: null, distance: null,
      notes: null, order_index: i, rest_time: null, intensity: null, load_used: r.load_used ?? null, rpe: null, group_id: null,
      suggestion_note: null,
    }).execute()
  }
  return { programId: program.id, workoutId, ids }
}

function input(over: Partial<SaveVideoAnalysisInput> = {}): SaveVideoAnalysisInput {
  return {
    mediaId: null, athleteId: null, sourceLabel: 'squat.mp4',
    track: [{ t: 0, x: 10, y: 100 }, { t: 0.5, x: 10, y: 60 }, { t: 1, x: 10, y: 100 }],
    calibration: null, metrics: [], notes: null, metric: null, lift: 'back-squat', loadKg: 180, calledRpe: null, ...over,
  }
}

const rows = (r: Row[]) => r.map((x) => ({ weight: null, load_used: null, ...x }))

describe('which row a set fits', () => {
  it('the lift by name, narrowed by the planned load', () => {
    const day = rows([{ name: 'Squat', weight: 180 }, { name: 'Squat', weight: 150 }, { name: 'Bench', weight: 180 }])
    expect(rowsFittingSet(day, 'back-squat', 182.5).map((r) => r.weight)).toEqual([180])
    expect(soleFit(day, 'back-squat', 182.5)?.weight).toBe(180)
  })

  it('or by the load the athlete logged', () => {
    const day = rows([{ name: 'Squat', weight: 170 }, { name: 'Squat', load_used: '190' }])
    expect(soleFit(day, 'back-squat', 190)?.load_used).toBe('190')
  })

  it('every row of the lift when no load agrees; none picked when several', () => {
    const day = rows([{ name: 'Squat', weight: 140 }, { name: 'Pause squat', weight: 120 }, { name: 'Bench' }])
    expect(rowsFittingSet(day, 'back-squat', 200)).toHaveLength(2)
    expect(soleFit(day, 'back-squat', 200)).toBeNull()
  })

  it('variations are kept apart by the lift name rules', () => {
    const day = rows([{ name: 'Deadlift', weight: 200 }, { name: 'Romanian deadlift', weight: 120 }, { name: 'Sumo deadlift', weight: 200 }])
    expect(soleFit(day, 'deadlift-conventional', null)?.name).toBe('Deadlift')
    expect(soleFit(day, 'deadlift-sumo', 200)?.name).toBe('Sumo deadlift')
  })

  it('an unknown lift fits nothing', () => {
    const day = rows([{ name: 'Bench', weight: 100 }])
    expect(rowsFittingSet(day, 'other', 100)).toEqual([])
    expect(rowsFittingSet(day, null, 100)).toEqual([])
  })
})

describe('linkCandidates', () => {
  it("the athlete's days within a week, closest first, the sole fit suggested", async () => {
    const a = await athlete()
    const near = await day(a, '2026-11-17', [{ name: 'Squat', weight: 180 }, { name: 'Bench', weight: 100 }])
    await day(a, '2026-11-20', [{ name: 'Squat', weight: 150 }, { name: 'Squat', weight: 140 }], 'Light day')
    await day(a, '2026-12-01', [{ name: 'Squat' }], 'Too far')
    await day(await athlete('Bo'), '2026-11-17', [{ name: 'Squat', weight: 180 }], 'Not hers')
    const days = await linkCandidates(a, '2026-11-18', 'back-squat', 180)
    expect(days.map((d) => d.workoutName)).toEqual(['Heavy day', 'Light day'])
    expect(days[0].suggestedExerciseId).toBe(near.ids[0])
    expect(days[0].rows.map((r) => r.fits)).toEqual([true, false])
    expect(days[1].suggestedExerciseId).toBeNull()
  })
})

describe('linkProblem', () => {
  it('refuses a day of another athlete, and a row of another day', async () => {
    const a = await athlete()
    const b = await athlete('Bo')
    const mine = await day(a, '2026-11-17', [{ name: 'Squat' }])
    const theirs = await day(b, '2026-11-17', [{ name: 'Squat' }])
    expect(await linkProblem(a, mine.workoutId, mine.ids[0])).toBeNull()
    expect(await linkProblem(a, mine.workoutId, null)).toBeNull()
    expect(await linkProblem(a, theirs.workoutId, null)).toMatch(/another athlete/)
    expect(await linkProblem(a, mine.workoutId, theirs.ids[0])).toMatch(/not on the training day/)
    expect(await linkProblem(null, mine.workoutId, null)).toMatch(/whose set/)
    expect(await linkProblem(a, null, mine.ids[0])).toMatch(/training day too/)
    expect(await linkProblem(a, 'gone', null)).toMatch(/no longer exists/)
  })
})

describe('the link on a saved analysis', () => {
  it('is saved, read back with names, and survives as day-only when the row goes', async () => {
    const a = await athlete()
    const d = await day(a, '2026-11-17', [{ name: 'Squat', weight: 180 }])
    const saved = await saveAnalysis(input({ athleteId: a, workoutId: d.workoutId, exerciseId: d.ids[0] }))
    expect(saved.link).toEqual({
      workoutId: d.workoutId, date: '2026-11-17', workoutName: 'Heavy day', programId: d.programId, programName: 'Block',
      exerciseId: d.ids[0], exerciseName: 'Squat', exerciseVelocity: null,
    })
    await getDb().deleteFrom('exercises').where('id', '=', d.ids[0]).execute()
    expect((await getAnalysis(saved.id))!.link).toMatchObject({ workoutId: d.workoutId, exerciseId: null, exerciseName: null })
    await getDb().deleteFrom('workouts').where('id', '=', d.workoutId).execute()
    expect((await getAnalysis(saved.id))!.link).toBeNull()
  })

  it("carries the row's velocity target (BP39), in the link and the candidates", async () => {
    const a = await athlete()
    const d = await day(a, '2026-11-17', [{ name: 'Squat', weight: 180 }])
    await getDb().updateTable('exercises').set({ velocity: '0.50 · VL 20%' }).where('id', '=', d.ids[0]).execute()
    const saved = await saveAnalysis(input({ athleteId: a, workoutId: d.workoutId, exerciseId: d.ids[0] }))
    expect(saved.link?.exerciseVelocity).toBe('0.50 · VL 20%')
    const days = await linkCandidates(a, '2026-11-17', 'back-squat', 180)
    expect(days[0].rows[0].velocity).toBe('0.50 · VL 20%')
  })

  it('a different athlete clears it; changing the day without a row clears the row', async () => {
    const a = await athlete()
    const d = await day(a, '2026-11-17', [{ name: 'Squat' }])
    const d2 = await day(a, '2026-11-19', [{ name: 'Squat' }])
    const saved = await saveAnalysis(input({ athleteId: a, workoutId: d.workoutId, exerciseId: d.ids[0] }))
    const moved = await updateAnalysisContext(saved.id, { workoutId: d2.workoutId })
    expect(moved!.link).toMatchObject({ workoutId: d2.workoutId, exerciseId: null })
    const same = await updateAnalysisContext(saved.id, { athleteId: a, notes: 'x' })
    expect(same!.link?.workoutId).toBe(d2.workoutId)
    const other = await updateAnalysisContext(saved.id, { athleteId: await athlete('Bo') })
    expect(other!.link).toBeNull()
  })
})

describe('routes', () => {
  let server: Server
  let base: string
  const start = async () => {
    server = createApp().listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/analysis`
  }
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())))
  const post = (url: string, body: unknown, method = 'POST') =>
    fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('refuses a save linked to another athlete\'s day, and stores nothing', async () => {
    await start()
    const a = await athlete()
    const theirs = await day(await athlete('Bo'), '2026-11-17', [{ name: 'Squat' }])
    const res = await post(base, { ...input({ athleteId: a }), workoutId: theirs.workoutId })
    expect(res.status).toBe(400)
    expect(await getDb().selectFrom('video_analyses').selectAll().execute()).toHaveLength(0)
  })

  it('links from the saved page, and lists candidates', async () => {
    await start()
    const a = await athlete()
    const d = await day(a, '2026-11-17', [{ name: 'Squat', weight: 180 }])
    const saved = await saveAnalysis(input({ athleteId: a }))
    const cands = await (await fetch(`${base}/link-candidates?athleteId=${a}&day=2026-11-17&lift=back-squat&loadKg=180`)).json()
    expect(cands[0].suggestedExerciseId).toBe(d.ids[0])
    const res = await post(`${base}/${saved.id}`, { workoutId: d.workoutId, exerciseId: d.ids[0] }, 'PATCH')
    expect(res.status).toBe(200)
    expect((await res.json()).link.exerciseName).toBe('Squat')
    const unlink = await post(`${base}/${saved.id}`, { workoutId: null }, 'PATCH')
    expect((await unlink.json()).link).toBeNull()
  })
})

describe('the upgrade (D70)', () => {
  it('links old analyses of clips on a day, the row only when one fits, once', async () => {
    const a = await athlete()
    const clear = await day(a, '2026-11-17', [{ name: 'Squat', weight: 180 }, { name: 'Bench', weight: 100 }])
    const unclear = await day(a, '2026-11-18', [{ name: 'Squat', weight: 150 }, { name: 'Squat', weight: 140 }], 'Volume')
    const otherAthlete = await day(await athlete('Bo'), '2026-11-17', [{ name: 'Squat' }])
    const db = getDb()
    await db.insertInto('discord_users').values({
      id: 'u1', username: 'ada', display_name: null, avatar_url: null, athlete_id: null, linked_at: null, first_seen_at: now(),
    }).execute()
    const media = async (workoutId: string) => {
      const id = uuidv4()
      await db.insertInto('discord_media').values({
        id, channel_id: 'c1', channel_name: '#form-checks', message_id: `m-${id}`, attachment_id: `a-${id}`, discord_user_id: 'u1',
        athlete_id: a, workout_id: workoutId, suggested_workout_id: null, filename: 'v.mp4', content_type: 'video/mp4', size_bytes: 1,
        width: null, height: null, message_content: null, posted_at: '2026-11-17T10:00:00.000Z', posted_date: '2026-11-17',
        source_url: null, local_path: null, sha256: null, download_status: 'downloaded', download_error: null, duplicate_of_id: null,
        reviewed: 1, created_at: now(),
      }).execute()
      return id
    }
    const one = await saveAnalysis(input({ athleteId: a, mediaId: await media(clear.workoutId), loadKg: 180 }))
    const two = await saveAnalysis(input({ athleteId: a, mediaId: await media(unclear.workoutId), loadKg: 200 }))
    const wrong = await saveAnalysis(input({ athleteId: a, mediaId: await media(otherAthlete.workoutId) }))
    const local = await saveAnalysis(input({ athleteId: a }))

    // Back to before L2: the columns gone, as on a 1.17 database.
    await sql`DROP INDEX IF EXISTS idx_video_analyses_workout`.execute(db)
    await sql`ALTER TABLE video_analyses DROP COLUMN workout_id`.execute(db)
    await sql`ALTER TABLE video_analyses DROP COLUMN exercise_id`.execute(db)
    await db.destroy()
    await initializeDatabase(dbPath)

    expect((await getAnalysis(one.id))!.link).toMatchObject({ workoutId: clear.workoutId, exerciseId: clear.ids[0] })
    expect((await getAnalysis(two.id))!.link).toMatchObject({ workoutId: unclear.workoutId, exerciseId: null })
    expect((await getAnalysis(wrong.id))!.link).toBeNull()
    expect((await getAnalysis(local.id))!.link).toBeNull()

    // Once: an unlinked one stays unlinked on the next start.
    await updateAnalysisContext(one.id, { workoutId: null })
    await getDb().destroy()
    await initializeDatabase(dbPath)
    expect((await getAnalysis(one.id))!.link).toBeNull()
  })
})
