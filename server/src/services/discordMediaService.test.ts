import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import {
  listMedia,
  getInboxCounts,
  linkUser,
  assignMediaToAthlete,
  setMediaWorkout,
  listWorkoutCandidates,
  listUsers,
  disconnect,
} from './discordMediaService.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-dms-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})

afterEach(async () => {
  // Close the sqlite handle before deleting the temp dir (Windows EBUSY).
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const now = () => new Date().toISOString()

async function createAthleteWithWorkout(opts: {
  name: string
  scheduledDate: string
  workoutName?: string
  exercises?: { name: string; weight?: number; reps?: string }[]
}) {
  const db = getDb()
  const athleteId = uuidv4()
  const programId = uuidv4()
  const workoutId = uuidv4()
  await db.insertInto('athletes').values({
    id: athleteId, name: opts.name, email: null, sport: null, date_of_birth: null,
    notes: null, archived: 0, created_at: now(), updated_at: now(),
  }).execute()
  await db.insertInto('programs').values({
    id: programId, athlete_id: athleteId, name: `${opts.name} block`, description: null,
    start_date: null, end_date: null, status: 'active', created_at: now(), updated_at: now(),
    enabled_columns: null, focus: null, export_layout: null, export_template_xlsx: null,
    builtin_template: 'coachboard',
  }).execute()
  await db.insertInto('workouts').values({
    id: workoutId, program_id: programId, name: opts.workoutName ?? 'Session',
    scheduled_date: opts.scheduledDate, completed_at: null, notes: null, created_at: now(),
  }).execute()
  for (const [i, ex] of (opts.exercises ?? []).entries()) {
    await db.insertInto('exercises').values({
      id: uuidv4(), workout_id: workoutId, name: ex.name, sets: '3', reps: ex.reps ?? '5',
      weight: ex.weight ?? null, duration: null, distance: null, notes: null, order_index: i,
      rest_time: null, intensity: null, load_used: null, rpe: null, group_id: null,
      suggestion_note: null,
    }).execute()
  }
  return { athleteId, programId, workoutId }
}

async function createDiscordMedia(opts: {
  userId: string
  postedDate: string
  caption?: string
  athleteId?: string | null
}) {
  const db = getDb()
  await db.insertInto('discord_users').values({
    id: opts.userId, username: opts.userId, display_name: null, avatar_url: null,
    athlete_id: null, linked_at: null, first_seen_at: now(),
  }).onConflict((oc) => oc.column('id').doNothing()).execute()

  const id = uuidv4()
  await db.insertInto('discord_media').values({
    id, channel_id: 'c1', channel_name: '#form-checks',
    message_id: `m-${id}`, attachment_id: `a-${id}`, discord_user_id: opts.userId,
    athlete_id: opts.athleteId ?? null, workout_id: null, suggested_workout_id: null,
    filename: 'video.mp4', content_type: 'video/mp4', size_bytes: 100, width: null, height: null,
    message_content: opts.caption ?? null,
    posted_at: `${opts.postedDate}T10:00:00.000Z`, posted_date: opts.postedDate,
    source_url: null, local_path: null, sha256: null,
    download_status: 'pending', download_error: null, duplicate_of_id: null,
    reviewed: 0, created_at: now(),
  }).execute()
  return id
}

describe('linkUser', () => {
  it('retro-files ALL of the user’s media and computes workout suggestions', async () => {
    const { athleteId, workoutId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-07-03',
      exercises: [{ name: 'Squat', weight: 180, reps: '2' }],
    })
    await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03', caption: '180 kg for 2' })
    await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-04' })
    await createDiscordMedia({ userId: 'other', postedDate: '2026-07-03' })

    const result = await linkUser('u1', athleteId)
    expect(result.updatedMedia).toBe(2)

    const rows = await getDb()
      .selectFrom('discord_media').selectAll().where('discord_user_id', '=', 'u1').execute()
    expect(rows.every((r) => r.athlete_id === athleteId)).toBe(true)
    // Both posts are within ±1 day of the only workout → suggested.
    expect(rows.every((r) => r.suggested_workout_id === workoutId)).toBe(true)

    const untouched = await getDb()
      .selectFrom('discord_media').selectAll().where('discord_user_id', '=', 'other').execute()
    expect(untouched[0].athlete_id).toBeNull()
  })

  it('unlinking returns media to the unmatched queue and clears attachments', async () => {
    const { athleteId, workoutId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-07-03',
    })
    const mediaId = await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' })
    await linkUser('u1', athleteId)
    await setMediaWorkout(mediaId, workoutId)

    await linkUser('u1', null)

    const row = await getDb()
      .selectFrom('discord_media').selectAll().where('id', '=', mediaId).executeTakeFirstOrThrow()
    expect(row.athlete_id).toBeNull()
    expect(row.workout_id).toBeNull()
    expect(row.suggested_workout_id).toBeNull()
  })

  it('two Discord accounts can link to the same athlete', async () => {
    const { athleteId } = await createAthleteWithWorkout({ name: 'Anna', scheduledDate: '2026-07-03' })
    await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' })
    await createDiscordMedia({ userId: 'u1-alt', postedDate: '2026-07-03' })
    await linkUser('u1', athleteId)
    await linkUser('u1-alt', athleteId)

    const users = await listUsers({})
    expect(users.filter((u) => u.athleteId === athleteId)).toHaveLength(2)
  })
})

describe('suggestion windows (via assignMediaToAthlete)', () => {
  it('suggests the single workout within ±1 day', async () => {
    const { athleteId, workoutId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-07-02',
    })
    const mediaId = await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' })
    await assignMediaToAthlete(mediaId, athleteId)
    const row = await getDb()
      .selectFrom('discord_media').selectAll().where('id', '=', mediaId).executeTakeFirstOrThrow()
    expect(row.suggested_workout_id).toBe(workoutId)
  })

  it('leaves no suggestion when two same-day workouts are indistinguishable', async () => {
    const db = getDb()
    const { athleteId, programId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-07-03', workoutName: 'AM',
    })
    await db.insertInto('workouts').values({
      id: uuidv4(), program_id: programId, name: 'PM', scheduled_date: '2026-07-03',
      completed_at: null, notes: null, created_at: now(),
    }).execute()

    const mediaId = await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' })
    await assignMediaToAthlete(mediaId, athleteId)
    const row = await db
      .selectFrom('discord_media').selectAll().where('id', '=', mediaId).executeTakeFirstOrThrow()
    expect(row.suggested_workout_id).toBeNull()
  })

  it('ignores workouts of detached (athlete-less) programs', async () => {
    const db = getDb()
    const { athleteId } = await createAthleteWithWorkout({ name: 'Anna', scheduledDate: '2026-06-01' })
    // A detached program with a perfectly-dated workout must not be suggested.
    const orphanProgram = uuidv4()
    await db.insertInto('programs').values({
      id: orphanProgram, athlete_id: null, name: 'Detached', description: null,
      start_date: null, end_date: null, status: 'archived', created_at: now(), updated_at: now(),
      enabled_columns: null, focus: null, export_layout: null, export_template_xlsx: null,
      builtin_template: 'coachboard',
    }).execute()
    await db.insertInto('workouts').values({
      id: uuidv4(), program_id: orphanProgram, name: 'Ghost', scheduled_date: '2026-07-03',
      completed_at: null, notes: null, created_at: now(),
    }).execute()

    const mediaId = await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' })
    await assignMediaToAthlete(mediaId, athleteId)
    const row = await db
      .selectFrom('discord_media').selectAll().where('id', '=', mediaId).executeTakeFirstOrThrow()
    expect(row.suggested_workout_id).toBeNull()
  })
})

describe('listMedia / counts / candidates', () => {
  it('filters unmatched vs unreviewed and counts them', async () => {
    const { athleteId } = await createAthleteWithWorkout({ name: 'Anna', scheduledDate: '2026-07-03' })
    await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' })
    await createDiscordMedia({ userId: 'u2', postedDate: '2026-07-03', athleteId })

    const unmatched = await listMedia({ filter: 'unmatched' })
    expect(unmatched.total).toBe(1)
    expect(unmatched.items[0].athleteId).toBeNull()

    const unreviewed = await listMedia({ filter: 'unreviewed' })
    expect(unreviewed.total).toBe(1)
    expect(unreviewed.items[0].athleteId).toBe(athleteId)

    expect(await getInboxCounts()).toEqual({ unmatched: 1, unreviewed: 1 })
  })

  it('recomputes a missing suggestion on read (coach programmed after the video arrived)', async () => {
    const db = getDb()
    // Media arrives first — matched to the athlete, but no workouts exist yet.
    const { athleteId, programId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-01-01', // far away — no suggestion possible yet
    })
    const mediaId = await createDiscordMedia({
      userId: 'u1', postedDate: '2026-07-03', athleteId,
    })

    // Coach programs the week afterwards.
    const newWorkout = uuidv4()
    await db.insertInto('workouts').values({
      id: newWorkout, program_id: programId, name: 'Squat day', scheduled_date: '2026-07-03',
      completed_at: null, notes: null, created_at: now(),
    }).execute()

    const { items } = await listMedia({ filter: 'unreviewed' })
    expect(items.find((i) => i.id === mediaId)?.suggestedWorkoutId).toBe(newWorkout)
  })

  it('filters by program via the confirmed workout join', async () => {
    const { athleteId, workoutId, programId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-07-03',
    })
    const mediaId = await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03', athleteId })
    await setMediaWorkout(mediaId, workoutId)

    const forProgram = await listMedia({ programId })
    expect(forProgram.total).toBe(1)
    expect(forProgram.items[0].workoutId).toBe(workoutId)

    const other = await listMedia({ programId: uuidv4() })
    expect(other.total).toBe(0)
  })

  it('confirming a workout marks the item reviewed', async () => {
    const { athleteId, workoutId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-07-03',
    })
    const mediaId = await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03', athleteId })
    await setMediaWorkout(mediaId, workoutId)
    const row = await getDb()
      .selectFrom('discord_media').selectAll().where('id', '=', mediaId).executeTakeFirstOrThrow()
    expect(row.reviewed).toBe(1)
  })

  it('lists workout candidates within ±7 days, closest first, drafts excluded', async () => {
    const db = getDb()
    const { athleteId, programId, workoutId } = await createAthleteWithWorkout({
      name: 'Anna', scheduledDate: '2026-07-01',
    })
    const near = uuidv4()
    await db.insertInto('workouts').values({
      id: near, program_id: programId, name: 'Later', scheduled_date: '2026-07-08',
      completed_at: null, notes: null, created_at: now(),
    }).execute()
    await db.insertInto('workouts').values({
      id: uuidv4(), program_id: programId, name: 'Too far', scheduled_date: '2026-08-01',
      completed_at: null, notes: null, created_at: now(),
    }).execute()

    // A [Draft] program day on the exact date must not clutter the picker.
    const draftProgram = uuidv4()
    await db.insertInto('programs').values({
      id: draftProgram, athlete_id: athleteId, name: '[Draft] Next block', description: null,
      start_date: null, end_date: null, status: 'draft', created_at: now(), updated_at: now(),
      enabled_columns: null, focus: null, export_layout: null, export_template_xlsx: null,
      builtin_template: 'coachboard',
    }).execute()
    await db.insertInto('workouts').values({
      id: uuidv4(), program_id: draftProgram, name: 'Draft day', scheduled_date: '2026-07-03',
      completed_at: null, notes: null, created_at: now(),
    }).execute()

    const mediaId = await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03', athleteId })
    const candidates = await listWorkoutCandidates(mediaId)
    // Closest day first (Jul 1 is 2 days away, Jul 8 is 5), draft day absent.
    expect(candidates.map((c) => c.workoutId)).toEqual([workoutId, near])
  })
})

describe('disconnect', () => {
  it('purge removes all discord rows', async () => {
    const { athleteId } = await createAthleteWithWorkout({ name: 'Anna', scheduledDate: '2026-07-03' })
    await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03', athleteId })

    await disconnect({ purge: true })

    const db = getDb()
    expect(await db.selectFrom('discord_media').selectAll().execute()).toHaveLength(0)
    expect(await db.selectFrom('discord_users').selectAll().execute()).toHaveLength(0)
    expect(await db.selectFrom('discord_channels').selectAll().execute()).toHaveLength(0)
    // The athlete itself is untouched.
    expect(await db.selectFrom('athletes').selectAll().execute()).toHaveLength(1)
  })

  it('keep-data leaves rows in place', async () => {
    await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' })
    await disconnect({ purge: false })
    expect(await getDb().selectFrom('discord_media').selectAll().execute()).toHaveLength(1)
  })
})
