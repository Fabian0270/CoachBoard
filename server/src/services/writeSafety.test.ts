import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb, getSqlite } from '../db.js'
import { createAthlete } from './athleteService.js'
import { createProgram, createWorkout, createExercise, addSetToExercise } from './programService.js'
import { generateDraftProgram } from './suggestionService.js'
import { configureSecureStore, type SafeStorageLike } from './secureStore.js'
import {
  saveToken,
  setAutoSync,
  setRetentionDays,
  setMessageRetentionDays,
  markTokenInvalid,
  getPublicSettings,
} from './discordSettingsService.js'
import { saveSettings, getSettings } from './emailSettingsService.js'
import { sweepPartialMedia, mediaRoot } from './mediaStore.js'
import { countExpiring } from './discordMediaService.js'

// Writes that used to fail silently or half-way. Where a failure has to happen
// partway through, a SQLite trigger makes it happen for real rather than a mock
// pretending to.

const fakeSafeStorage: SafeStorageLike = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptStringAsync: async (b) => ({ result: b.toString('utf8').replace(/^enc:/, '') }),
}

let dir = ''

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-writes-'))
  configureSecureStore({ safeStorage: fakeSafeStorage, userDataDir: dir })
  await initializeDatabase(':memory:')
})

afterEach(async () => {
  await getDb().destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Makes every later insert matching `when` abort, as a disk or constraint error would. */
function failInsertsWhere(when: string) {
  getSqlite().exec(
    `CREATE TRIGGER fail_midway BEFORE INSERT ON exercises WHEN ${when}
     BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
  )
}

describe('draft generation is all or nothing', () => {
  it('leaves no half-built draft when a write fails partway', async () => {
    const athlete = await createAthlete({ name: 'Lifter' })
    const source = await createProgram({
      athlete_id: athlete.id, name: 'Done Block', start_date: '2026-01-05', end_date: '2026-01-11',
      status: 'completed',
    })
    for (const [i, name] of ['Squat', 'Bench Press', 'Deadlift'].entries()) {
      const date = `2026-01-0${5 + i * 2}`
      const w = await createWorkout({ program_id: source.id, name: date, scheduled_date: date })
      await createExercise({ workout_id: w.id, name, sets: '3', reps: '5', load_used: '100', rpe: '8' })
    }
    const workoutsBefore = (await getDb().selectFrom('workouts').select('id').execute()).length

    // Squat and bench rows go in first; the first deadlift row aborts.
    failInsertsWhere(`NEW.name = 'Deadlift'`)
    await expect(
      generateDraftProgram(source.id, {
        athleteId: athlete.id, templateId: 'strength_linear', weeks: 4,
        trainingDaysPerWeek: 3, startDate: '2026-02-02',
      }),
    ).rejects.toThrow(/simulated failure/)

    const drafts = await getDb().selectFrom('programs').select('id').where('status', '=', 'draft').execute()
    expect(drafts).toHaveLength(0)
    expect((await getDb().selectFrom('workouts').select('id').execute()).length).toBe(workoutsBefore)
  })
})

describe('add-set is all or nothing', () => {
  it('does not regroup or shift anything when the new set cannot be inserted', async () => {
    const athlete = await createAthlete({ name: 'Lifter' })
    const program = await createProgram({ athlete_id: athlete.id, name: 'P' })
    const w = await createWorkout({ program_id: program.id, name: 'Day', scheduled_date: '2026-01-05' })
    const a = await createExercise({ workout_id: w.id, name: 'Squat', order_index: 0 })
    await createExercise({ workout_id: w.id, name: 'Bench', order_index: 1 })
    await createExercise({ workout_id: w.id, name: 'Row', order_index: 2 })

    failInsertsWhere(`NEW.group_id IS NOT NULL`)
    await expect(addSetToExercise(a.id, w.id, program.id)).rejects.toThrow(/simulated failure/)

    const rows = await getDb()
      .selectFrom('exercises').select(['name', 'order_index', 'group_id'])
      .where('workout_id', '=', w.id).orderBy('order_index').execute()
    expect(rows).toEqual([
      { name: 'Squat', order_index: 0, group_id: null },
      { name: 'Bench', order_index: 1, group_id: null },
      { name: 'Row', order_index: 2, group_id: null },
    ])
  })
})

describe('settings files', () => {
  it('keeps every change when several land at once', async () => {
    await saveToken('a-test-token-that-is-long-enough', {
      applicationId: 'app', botUserId: 'bot', botUsername: 'coachbot',
    })
    // Each of these is read-modify-write. Unqueued, they all read the same old
    // file and the last one to finish discarded the others.
    await Promise.all([
      setRetentionDays(30),
      setAutoSync({ enabled: true, minutes: 15 }),
      setMessageRetentionDays(60),
      markTokenInvalid(true),
    ])
    const s = await getPublicSettings()
    expect(s).toMatchObject({
      retentionDays: 30,
      autoSyncEnabled: true,
      autoSyncMinutes: 15,
      messageRetentionDays: 60,
      tokenInvalid: true,
      botUsername: 'coachbot',
    })
  })

  it('writes through a temporary file and leaves none behind', async () => {
    await saveSettings({ provider: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true, user: 'c@example.com', password: 'pw' })
    expect((await getSettings())?.configured).toBe(true)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('sweepPartialMedia', () => {
  it('removes abandoned .part files anywhere under media and keeps finished files', async () => {
    const root = mediaRoot()
    const put = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), 'x')
    }
    put('analyses/0b6a3c3e-0000-4000-8000-000000000000.mp4.part')
    put('discord/2026-07/1_2_video.mp4.part')
    put('analyses/0b6a3c3e-0000-4000-8000-000000000001.mp4')

    expect(await sweepPartialMedia()).toBe(2)
    expect(fs.existsSync(path.join(root, 'analyses/0b6a3c3e-0000-4000-8000-000000000001.mp4'))).toBe(true)
  })

  it('is a no-op before any media exists', async () => {
    expect(await sweepPartialMedia()).toBe(0)
  })
})

describe('countExpiring', () => {
  it('counts what retention would delete, sparing videos with a saved analysis', async () => {
    const db = getDb()
    await db.insertInto('discord_users').values({
      id: 'u1', username: 'u1', display_name: null, avatar_url: null, athlete_id: null,
      linked_at: null, first_seen_at: new Date().toISOString(),
    }).execute()
    const media = (id: string, postedAt: string) => ({
      id, channel_id: 'c', channel_name: '#c', message_id: id, attachment_id: id, discord_user_id: 'u1',
      athlete_id: null, workout_id: null, suggested_workout_id: null, filename: 'v.mp4',
      content_type: 'video/mp4', size_bytes: 1, width: null, height: null, message_content: null,
      posted_at: postedAt, posted_date: postedAt.slice(0, 10), source_url: null, local_path: null,
      sha256: null, download_status: 'downloaded', download_error: null, duplicate_of_id: null,
      reviewed: 0, created_at: postedAt,
    })
    const old = '2020-01-01T00:00:00.000Z'
    await db.insertInto('discord_media').values([
      media('old', old), media('analysed', old), media('new', new Date().toISOString()),
    ]).execute()
    await db.insertInto('video_analyses').values({
      id: 'a1', media_id: 'analysed', athlete_id: null, source_label: '', track: '[]',
      calibration: null, metrics: '[]', notes: null, created_at: old, updated_at: old,
    }).execute()

    expect(await countExpiring(90)).toEqual({ videos: 1, messages: 0 })
    expect(await countExpiring(0)).toEqual({ videos: 0, messages: 0 })
  })
})

describe('generated drafts use the competition lifts, not their variations', () => {
  it('keeps a Romanian deadlift as an accessory and loads from the plain max', async () => {
    const athlete = await createAthlete({ name: 'Lifter' })
    const { createAthleteMax } = await import('./athleteService.js')
    // Sorts first alphabetically, and used to set the whole block's bench loads.
    await createAthleteMax({ athlete_id: athlete.id, lift_name: 'Banded Bench', weight: 60, recorded_at: '2026-06-01' })
    await createAthleteMax({ athlete_id: athlete.id, lift_name: 'Bench Press', weight: 140, recorded_at: '2026-01-01' })

    const other = await createAthlete({ name: 'Source Owner' })
    const source = await createProgram({
      athlete_id: other.id, name: 'Done Block', start_date: '2026-01-05', end_date: '2026-01-11', status: 'completed',
    })
    const days: [string, string[]][] = [
      ['2026-01-05', ['Squat']],
      ['2026-01-07', ['Bench Press']],
      ['2026-01-09', ['Deadlift', 'Romanian Deadlift']],
    ]
    for (const [date, names] of days) {
      const w = await createWorkout({ program_id: source.id, name: date, scheduled_date: date })
      for (const [i, name] of names.entries()) {
        await createExercise({ workout_id: w.id, name, sets: '3', reps: '5', order_index: i })
      }
    }

    // A different athlete, so loads come from THEIR stored maxes.
    const { draftProgramId } = await generateDraftProgram(source.id, {
      athleteId: athlete.id, templateId: 'strength_linear', weeks: 1, trainingDaysPerWeek: 3, startDate: '2026-02-02',
    })
    const rows = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name as name', 'exercises.weight as weight', 'exercises.suggestion_note as note'])
      .where('workouts.program_id', '=', draftProgramId)
      .execute()

    const rdl = rows.find((r) => r.name === 'Romanian Deadlift')
    expect(rdl).toBeDefined() // carried over as an accessory, not folded into the deadlift
    const bench = rows.find((r) => r.name === 'Bench Press')!
    // strength_linear week 1: 5 reps @ RPE 7.5 is about 80% — of 140, not of 60.
    expect(bench.weight).toBeGreaterThan(100)
  })
})
