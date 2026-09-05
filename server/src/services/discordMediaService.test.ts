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
  deleteMedia,
  MediaHasAnalysisError,
  applyRetention,
  applyMessageRetention,
  clearCache,
  getStorageUsage,
  getAthleteConversation,
  markConversationRead,
  listUnreadThreads,
} from './discordMediaService.js'
import { saveAnalysis } from './videoAnalysisService.js'
import { resolveMediaAbsPath } from './mediaStore.js'

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

async function createDownloadedMedia(opts: {
  userId: string
  postedAt: string
  bytes: number
  relPath: string
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
    athlete_id: null, workout_id: null, suggested_workout_id: null,
    filename: 'video.mp4', content_type: 'video/mp4', size_bytes: opts.bytes, width: null, height: null,
    message_content: null, posted_at: opts.postedAt, posted_date: opts.postedAt.slice(0, 10),
    source_url: null, local_path: opts.relPath, sha256: 'x'.repeat(64),
    download_status: 'downloaded', download_error: null, duplicate_of_id: null,
    reviewed: 0, created_at: now(),
  }).execute()
  return id
}

async function insertInbound(opts: {
  userId: string
  athleteId: string | null
  content: string
  postedAt: string
  read?: number
}) {
  const id = uuidv4()
  await getDb().insertInto('discord_inbound_messages').values({
    id, discord_message_id: `dm-${id}`, channel_id: 'dm1', discord_user_id: opts.userId,
    athlete_id: opts.athleteId, content: opts.content, posted_at: opts.postedAt,
    read: opts.read ?? 0, created_at: now(),
  }).execute()
  return id
}

describe('deleteMedia', () => {
  it('removes the row and the file on disk', async () => {
    const rel = 'media/discord/2026-07/vid.mp4'
    const abs = resolveMediaAbsPath(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'bytes')
    const id = await createDownloadedMedia({ userId: 'u1', postedAt: now(), bytes: 5, relPath: rel })

    expect(await deleteMedia(id)).toBe(true)
    expect(await getDb().selectFrom('discord_media').selectAll().execute()).toHaveLength(0)
    expect(fs.existsSync(abs)).toBe(false)
  })

  it('returns false for a missing id', async () => {
    expect(await deleteMedia(uuidv4())).toBe(false)
  })

  it('refuses when a saved analysis depends on the video', async () => {
    // Automatic retention has exempted these all along, but this manual path
    // did not: the FK nulled video_analyses.media_id, so the analysis survived
    // and quietly lost the footage it was measured from.
    const rel = 'media/discord/2026-07/analysed.mp4'
    const abs = resolveMediaAbsPath(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'bytes')
    const id = await createDownloadedMedia({ userId: 'u1', postedAt: now(), bytes: 5, relPath: rel })
    await saveAnalysis({
      mediaId: id,
      athleteId: null,
      sourceLabel: 'analysed.mp4',
      track: [
        { t: 0, x: 1, y: 2 },
        { t: 1, x: 1, y: 3 },
      ],
      calibration: null,
      metrics: [],
      notes: null,
      lift: null,
      loadKg: null,
      calledRpe: null,
      metric: null,
    })

    await expect(deleteMedia(id)).rejects.toThrow(MediaHasAnalysisError)
    // Nothing was destroyed on the way to refusing.
    expect(fs.existsSync(abs)).toBe(true)
    expect(await getDb().selectFrom('discord_media').selectAll().execute()).toHaveLength(1)
  })
})

describe('applyRetention', () => {
  it('deletes media older than the window, keeps newer, and files too', async () => {
    const oldRel = 'media/discord/2020-01/old.mp4'
    const oldAbs = resolveMediaAbsPath(oldRel)
    fs.mkdirSync(path.dirname(oldAbs), { recursive: true })
    fs.writeFileSync(oldAbs, 'old')
    await createDownloadedMedia({ userId: 'u1', postedAt: '2020-01-01T00:00:00.000Z', bytes: 3, relPath: oldRel })
    await createDownloadedMedia({ userId: 'u1', postedAt: now(), bytes: 3, relPath: 'media/discord/2026-07/new.mp4' })

    const removed = await applyRetention(90)
    expect(removed).toBe(1)
    expect(fs.existsSync(oldAbs)).toBe(false)
    const remaining = await getDb().selectFrom('discord_media').selectAll().execute()
    expect(remaining).toHaveLength(1)
  })

  it('is a no-op when retention is Never (0)', async () => {
    await createDownloadedMedia({ userId: 'u1', postedAt: '2010-01-01T00:00:00.000Z', bytes: 3, relPath: 'media/discord/2010-01/x.mp4' })
    expect(await applyRetention(0)).toBe(0)
    expect(await getDb().selectFrom('discord_media').selectAll().execute()).toHaveLength(1)
  })
})

describe('message retention + clear cache', () => {
  const oldIso = '2020-01-01T00:00:00.000Z'
  const seedOldAndNewMessages = async () => {
    await insertInbound({ userId: 'u1', athleteId: null, content: 'old inbound', postedAt: oldIso })
    await insertInbound({ userId: 'u1', athleteId: null, content: 'new inbound', postedAt: now() })
    await getDb().insertInto('discord_sent_messages').values({
      id: uuidv4(), channel_id: 'dm1', kind: 'dm', discord_user_id: 'u1',
      related_media_id: null, reply_to_message_id: null, content: 'old outbound',
      status: 'sent', error: null, discord_message_id: 'x', created_at: oldIso,
    }).execute()
  }

  it('applyMessageRetention deletes messages older than the window', async () => {
    await seedOldAndNewMessages()
    const removed = await applyMessageRetention(90)
    expect(removed).toBe(2) // 1 old inbound + 1 old outbound
    expect(await getDb().selectFrom('discord_inbound_messages').selectAll().execute()).toHaveLength(1)
    expect(await getDb().selectFrom('discord_sent_messages').selectAll().execute()).toHaveLength(0)
  })

  it('applyMessageRetention is a no-op at 0 (Never)', async () => {
    await seedOldAndNewMessages()
    expect(await applyMessageRetention(0)).toBe(0)
    expect(await getDb().selectFrom('discord_inbound_messages').selectAll().execute()).toHaveLength(2)
  })

  it('clearCache deletes both videos and messages older than N days', async () => {
    await createDownloadedMedia({ userId: 'u1', postedAt: oldIso, bytes: 5, relPath: 'media/discord/2020-01/old.mp4' })
    await createDownloadedMedia({ userId: 'u1', postedAt: now(), bytes: 5, relPath: 'media/discord/2026-07/new.mp4' })
    await seedOldAndNewMessages()

    const result = await clearCache(90)
    expect(result.videosDeleted).toBe(1)
    expect(result.messagesDeleted).toBe(2)
    expect(await getDb().selectFrom('discord_media').selectAll().execute()).toHaveLength(1)
  })
})

describe('getStorageUsage', () => {
  it('sums only downloaded rows', async () => {
    await createDownloadedMedia({ userId: 'u1', postedAt: now(), bytes: 1000, relPath: 'media/discord/2026-07/a.mp4' })
    await createDownloadedMedia({ userId: 'u1', postedAt: now(), bytes: 2000, relPath: 'media/discord/2026-07/b.mp4' })
    await createDiscordMedia({ userId: 'u1', postedDate: '2026-07-03' }) // pending, no bytes on disk
    const usage = await getStorageUsage()
    expect(usage.bytes).toBe(3000)
    expect(usage.files).toBe(2)
  })
})

describe('conversation', () => {
  it('merges inbound + outbound DMs ordered by time and counts unread', async () => {
    const { athleteId } = await createAthleteWithWorkout({ name: 'Anna', scheduledDate: '2026-07-03' })
    await getDb().insertInto('discord_users').values({
      id: 'u1', username: 'anna', display_name: null, avatar_url: null,
      athlete_id: athleteId, linked_at: now(), first_seen_at: now(),
    }).execute()
    await insertInbound({ userId: 'u1', athleteId, content: 'hi coach', postedAt: '2026-07-03T10:00:00.000Z' })
    await getDb().insertInto('discord_sent_messages').values({
      id: uuidv4(), channel_id: 'dm1', kind: 'dm', discord_user_id: 'u1',
      related_media_id: null, reply_to_message_id: null, content: 'hi athlete',
      status: 'sent', error: null, discord_message_id: 'x', created_at: '2026-07-03T10:05:00.000Z',
    }).execute()

    const convo = await getAthleteConversation(athleteId)
    expect(convo.map((m) => m.direction)).toEqual(['in', 'out'])
    expect(convo[0].content).toBe('hi coach')

    expect((await getInboxCounts()).unreadMessages).toBe(1)
    const threads = await listUnreadThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0].unread).toBe(1)

    await markConversationRead(athleteId)
    expect((await getInboxCounts()).unreadMessages).toBe(0)
  })

  it('linkUser retro-attaches inbound messages to the athlete; unlink detaches', async () => {
    const { athleteId } = await createAthleteWithWorkout({ name: 'Anna', scheduledDate: '2026-07-03' })
    await getDb().insertInto('discord_users').values({
      id: 'u1', username: 'anna', display_name: null, avatar_url: null,
      athlete_id: null, linked_at: null, first_seen_at: now(),
    }).execute()
    await insertInbound({ userId: 'u1', athleteId: null, content: 'pre-link message', postedAt: now() })

    await linkUser('u1', athleteId)
    expect(await getAthleteConversation(athleteId)).toHaveLength(1)

    await linkUser('u1', null)
    expect(await getAthleteConversation(athleteId)).toHaveLength(0)
  })
})

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

    expect(await getInboxCounts()).toEqual({ unmatched: 1, unreviewed: 1, unreadMessages: 0 })
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
