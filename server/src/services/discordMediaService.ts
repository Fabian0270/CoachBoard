import { getDb } from '../db.js'
import type { DiscordMediaTable } from '../db.js'
import { computeSuggestedWorkoutId, ensureDmChannel, disableDmChannel, stopAutoSync } from './discordSyncService.js'
import { clearSettings } from './discordSettingsService.js'
import { deleteMediaFile } from './mediaStore.js'
import { parseCaption } from './captionMatcher.js'
import type {
  DiscordMediaItem,
  DiscordUserItem,
  InboxCounts,
  WorkoutCandidate,
} from 'coachboard-shared/discord'

// ---------------------------------------------------------------------------
// Read/review surface for synced media + the user↔athlete linking that makes
// "map once, everything files itself" true (linking retro-updates history).
// ---------------------------------------------------------------------------

export type MediaFilter = 'unmatched' | 'unreviewed' | 'all'

interface ListMediaOpts {
  filter?: MediaFilter
  athleteId?: string
  programId?: string
  limit?: number
  offset?: number
}

type MediaJoinRow = DiscordMediaTable & {
  author_username: string
  author_display_name: string | null
  author_avatar_url: string | null
  athlete_name: string | null
  workout_name: string | null
  workout_date: string | null
  workout_program_id: string | null
  program_name: string | null
  suggested_name: string | null
  suggested_date: string | null
}

function toItem(row: MediaJoinRow): DiscordMediaItem {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    messageId: row.message_id,
    discordUserId: row.discord_user_id,
    authorUsername: row.author_username,
    authorDisplayName: row.author_display_name,
    authorAvatarUrl: row.author_avatar_url,
    athleteId: row.athlete_id,
    athleteName: row.athlete_name,
    workoutId: row.workout_id,
    workoutName: row.workout_name,
    workoutDate: row.workout_date,
    suggestedWorkoutId: row.suggested_workout_id,
    suggestedWorkoutName: row.suggested_name,
    suggestedWorkoutDate: row.suggested_date,
    programId: row.workout_program_id,
    programName: row.program_name,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    caption: row.message_content,
    parsedCaption: row.message_content ? parseCaption(row.message_content) : null,
    postedAt: row.posted_at,
    downloadStatus: row.download_status as DiscordMediaItem['downloadStatus'],
    downloadError: row.download_error,
    duplicateOfId: row.duplicate_of_id,
    reviewed: row.reviewed === 1,
    playable: row.download_status === 'downloaded' && !!row.local_path,
    isVideo:
      row.content_type?.startsWith('video/') ??
      /\.(mp4|mov|webm|mkv|avi)$/i.test(row.filename),
  }
}

function baseMediaQuery() {
  return getDb()
    .selectFrom('discord_media')
    .innerJoin('discord_users', 'discord_users.id', 'discord_media.discord_user_id')
    .leftJoin('athletes', 'athletes.id', 'discord_media.athlete_id')
    .leftJoin('workouts as confirmed_w', 'confirmed_w.id', 'discord_media.workout_id')
    .leftJoin('programs as confirmed_p', 'confirmed_p.id', 'confirmed_w.program_id')
    .leftJoin('workouts as suggested_w', 'suggested_w.id', 'discord_media.suggested_workout_id')
    .selectAll('discord_media')
    .select([
      'discord_users.username as author_username',
      'discord_users.display_name as author_display_name',
      'discord_users.avatar_url as author_avatar_url',
      'athletes.name as athlete_name',
      'confirmed_w.name as workout_name',
      'confirmed_w.scheduled_date as workout_date',
      'confirmed_w.program_id as workout_program_id',
      'confirmed_p.name as program_name',
      'suggested_w.name as suggested_name',
      'suggested_w.scheduled_date as suggested_date',
    ])
}

export async function listMedia(
  opts: ListMediaOpts,
): Promise<{ items: DiscordMediaItem[]; total: number }> {
  const db = getDb()

  // Suggestions computed at sync time go stale when the coach programs a week
  // AFTER the videos arrived — recompute here for matched rows that have
  // neither a confirmed nor a suggested workout.
  const stale = await db
    .selectFrom('discord_media')
    .select(['id', 'athlete_id', 'posted_date', 'message_content'])
    .where('athlete_id', 'is not', null)
    .where('workout_id', 'is', null)
    .where('suggested_workout_id', 'is', null)
    .execute()
  for (const row of stale) {
    const suggested = await computeSuggestedWorkoutId(
      db,
      row.athlete_id!,
      row.posted_date,
      row.message_content,
    )
    if (suggested) {
      await db
        .updateTable('discord_media')
        .set({ suggested_workout_id: suggested })
        .where('id', '=', row.id)
        .execute()
    }
  }

  let query = baseMediaQuery()
  if (opts.filter === 'unmatched') {
    query = query.where('discord_media.athlete_id', 'is', null).where('discord_media.reviewed', '=', 0)
  } else if (opts.filter === 'unreviewed') {
    query = query.where('discord_media.athlete_id', 'is not', null).where('discord_media.reviewed', '=', 0)
  }
  if (opts.athleteId) query = query.where('discord_media.athlete_id', '=', opts.athleteId)
  if (opts.programId) query = query.where('confirmed_w.program_id', '=', opts.programId)

  const rows = await query
    .orderBy('discord_media.posted_at', 'desc')
    .limit(Math.min(opts.limit ?? 100, 500))
    .offset(opts.offset ?? 0)
    .execute()

  let countQuery = db.selectFrom('discord_media')
  if (opts.filter === 'unmatched') {
    countQuery = countQuery.where('athlete_id', 'is', null).where('reviewed', '=', 0)
  } else if (opts.filter === 'unreviewed') {
    countQuery = countQuery.where('athlete_id', 'is not', null).where('reviewed', '=', 0)
  }
  if (opts.athleteId) countQuery = countQuery.where('athlete_id', '=', opts.athleteId)
  if (opts.programId) {
    countQuery = countQuery.where('workout_id', 'in', (eb) =>
      eb.selectFrom('workouts').select('id').where('program_id', '=', opts.programId!),
    )
  }
  const totalRow = await countQuery
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()

  return { items: (rows as MediaJoinRow[]).map(toItem), total: Number(totalRow?.n ?? 0) }
}

export async function getMediaRow(mediaId: string): Promise<DiscordMediaTable | undefined> {
  return getDb().selectFrom('discord_media').selectAll().where('id', '=', mediaId).executeTakeFirst()
}

export async function getMediaItem(mediaId: string): Promise<DiscordMediaItem | null> {
  const row = await baseMediaQuery().where('discord_media.id', '=', mediaId).executeTakeFirst()
  return row ? toItem(row as MediaJoinRow) : null
}

export async function getInboxCounts(): Promise<InboxCounts> {
  const db = getDb()
  const [unmatched, unreviewed] = await Promise.all([
    db
      .selectFrom('discord_media')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('athlete_id', 'is', null)
      .where('reviewed', '=', 0)
      .executeTakeFirst(),
    db
      .selectFrom('discord_media')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('athlete_id', 'is not', null)
      .where('reviewed', '=', 0)
      .executeTakeFirst(),
  ])
  return { unmatched: Number(unmatched?.n ?? 0), unreviewed: Number(unreviewed?.n ?? 0) }
}

/**
 * Links (or unlinks) a Discord user to an athlete and retroactively refiles
 * ALL their media — the "map once, everything files itself" promise, valid
 * for already-synced history too. Linking also opens the DM channel so the
 * athlete can DM videos to the bot from now on.
 */
export async function linkUser(
  discordUserId: string,
  athleteId: string | null,
): Promise<{ updatedMedia: number }> {
  const db = getDb()

  const updated = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('discord_users')
      .set({ athlete_id: athleteId, linked_at: athleteId ? new Date().toISOString() : null })
      .where('id', '=', discordUserId)
      .execute()

    if (athleteId === null) {
      // Unlink: back to the unmatched queue; confirmed attaches no longer apply.
      const res = await trx
        .updateTable('discord_media')
        .set({ athlete_id: null, workout_id: null, suggested_workout_id: null })
        .where('discord_user_id', '=', discordUserId)
        .executeTakeFirst()
      return Number(res.numUpdatedRows ?? 0n)
    }

    const rows = await trx
      .selectFrom('discord_media')
      .select(['id', 'posted_date', 'message_content'])
      .where('discord_user_id', '=', discordUserId)
      .execute()

    for (const row of rows) {
      const suggested = await computeSuggestedWorkoutId(
        trx,
        athleteId,
        row.posted_date,
        row.message_content,
      )
      await trx
        .updateTable('discord_media')
        .set({ athlete_id: athleteId, suggested_workout_id: suggested })
        .where('id', '=', row.id)
        .execute()
    }
    return rows.length
  })

  if (athleteId) {
    // Best-effort: DM channel needs Discord to be reachable; the link itself
    // must succeed regardless (offline-first).
    await ensureDmChannel(discordUserId).catch(() => {})
  } else {
    await disableDmChannel(discordUserId)
  }

  return { updatedMedia: updated }
}

/** One-off override for a single post (without creating a user link). */
export async function assignMediaToAthlete(
  mediaId: string,
  athleteId: string | null,
): Promise<void> {
  const db = getDb()
  const row = await db
    .selectFrom('discord_media')
    .select(['posted_date', 'message_content'])
    .where('id', '=', mediaId)
    .executeTakeFirst()
  if (!row) throw new Error('Media not found')

  const suggested = athleteId
    ? await computeSuggestedWorkoutId(db, athleteId, row.posted_date, row.message_content)
    : null

  await db
    .updateTable('discord_media')
    .set({ athlete_id: athleteId, suggested_workout_id: suggested, workout_id: null })
    .where('id', '=', mediaId)
    .execute()
}

/** Confirm (or clear) the workout attachment. Confirming also marks reviewed. */
export async function setMediaWorkout(mediaId: string, workoutId: string | null): Promise<void> {
  await getDb()
    .updateTable('discord_media')
    .set({ workout_id: workoutId, ...(workoutId ? { reviewed: 1 } : {}) })
    .where('id', '=', mediaId)
    .execute()
}

export async function setReviewed(mediaId: string, reviewed: boolean): Promise<void> {
  await getDb()
    .updateTable('discord_media')
    .set({ reviewed: reviewed ? 1 : 0 })
    .where('id', '=', mediaId)
    .execute()
}

export async function listUsers(opts: { unlinkedOnly?: boolean }): Promise<DiscordUserItem[]> {
  let query = getDb()
    .selectFrom('discord_users')
    .leftJoin('athletes', 'athletes.id', 'discord_users.athlete_id')
    .leftJoin('discord_media', 'discord_media.discord_user_id', 'discord_users.id')
    .select((eb) => [
      'discord_users.id as id',
      'discord_users.username as username',
      'discord_users.display_name as display_name',
      'discord_users.avatar_url as avatar_url',
      'discord_users.athlete_id as athlete_id',
      'discord_users.first_seen_at as first_seen_at',
      'athletes.name as athlete_name',
      eb.fn.count<number>('discord_media.id').as('media_count'),
    ])
    .groupBy('discord_users.id')

  if (opts.unlinkedOnly) query = query.where('discord_users.athlete_id', 'is', null)

  const rows = await query.orderBy('discord_users.username').execute()
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    athleteId: r.athlete_id,
    athleteName: r.athlete_name,
    mediaCount: Number(r.media_count),
    firstSeenAt: r.first_seen_at,
  }))
}

/** Nearby workouts for the "Pick other…" dialog (±7 days around the post). */
export async function listWorkoutCandidates(mediaId: string): Promise<WorkoutCandidate[]> {
  const db = getDb()
  const media = await db
    .selectFrom('discord_media')
    .select(['athlete_id', 'posted_date'])
    .where('id', '=', mediaId)
    .executeTakeFirst()
  if (!media?.athlete_id) return []

  const posted = Date.parse(media.posted_date)
  const rows = await db
    .selectFrom('workouts')
    .innerJoin('programs', 'programs.id', 'workouts.program_id')
    .select([
      'workouts.id as workout_id',
      'workouts.name as workout_name',
      'workouts.scheduled_date as scheduled_date',
      'programs.id as program_id',
      'programs.name as program_name',
      'programs.status as program_status',
    ])
    .where('programs.athlete_id', '=', media.athlete_id)
    .where('programs.status', '!=', 'draft') // engine drafts aren't real training days yet
    .where('workouts.scheduled_date', 'is not', null)
    .execute()

  // Active program first, then by how close the day is to the post date —
  // the right answer is almost always at the top.
  return rows
    .filter((r) => Math.abs(Date.parse(r.scheduled_date!) - posted) <= 7 * 86_400_000)
    .sort((a, b) => {
      const aActive = a.program_status === 'active' ? 0 : 1
      const bActive = b.program_status === 'active' ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      const aDist = Math.abs(Date.parse(a.scheduled_date!) - posted)
      const bDist = Math.abs(Date.parse(b.scheduled_date!) - posted)
      if (aDist !== bDist) return aDist - bDist
      return a.scheduled_date! < b.scheduled_date! ? -1 : 1
    })
    .map((r) => ({
      workoutId: r.workout_id,
      workoutName: r.workout_name,
      scheduledDate: r.scheduled_date,
      programId: r.program_id,
      programName: r.program_name,
    }))
}

/**
 * Disconnect. Always forgets the token and stops timers. With purge=true,
 * also deletes downloaded files (best-effort — a file open in the player may
 * be locked on Windows) and every discord_* row.
 */
export async function disconnect(opts: { purge: boolean }): Promise<{ deletedFiles: number }> {
  stopAutoSync()
  await clearSettings()

  if (!opts.purge) return { deletedFiles: 0 }

  const db = getDb()
  const files = await db
    .selectFrom('discord_media')
    .select('local_path')
    .where('local_path', 'is not', null)
    .execute()

  let deleted = 0
  for (const f of files) {
    if (f.local_path && (await deleteMediaFile(f.local_path))) deleted++
  }

  await db.deleteFrom('discord_sent_messages').execute()
  await db.deleteFrom('discord_media').execute()
  await db.deleteFrom('discord_users').execute()
  await db.deleteFrom('discord_channels').execute()

  return { deletedFiles: deleted }
}
