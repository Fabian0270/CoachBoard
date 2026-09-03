import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import type { Kysely, Transaction } from 'kysely'
import type { DB } from '../db.js'
import {
  createDiscordClient,
  DiscordApiError,
  maxSnowflake,
  avatarUrl,
  hasMessageContentIntent,
  type DiscordClient,
  type DiscordMessagePayload,
} from './discordApiClient.js'
import {
  getToken,
  markTokenInvalid,
  getBotUserId,
  getPublicSettings,
  getRetentionDays,
  getMessageRetentionDays,
} from './discordSettingsService.js'
import { applyRetention, applyMessageRetention } from './discordMediaService.js'
import { sweepOrphanThumbs } from './discordThumbService.js'
import {
  discordMediaRelPath,
  downloadToFile,
  resolveMediaAbsPath,
  MediaTooLargeError,
  MediaDownloadError,
} from './mediaStore.js'
import { parseCaption, suggestWorkout, type CandidateWorkout } from './captionMatcher.js'
import type { SyncStatusDto, StartSyncResult, SyncChannelProgress } from 'coachboard-shared/discord'

// ---------------------------------------------------------------------------
// The sync engine. REST polling with a per-channel snowflake cursor:
// GET /channels/{id}/messages?after={cursor}&limit=100, oldest→newest.
// Each page commits in ONE transaction (rows + cursor together), so a crash
// never loses or duplicates work — re-syncs are idempotent via the
// UNIQUE(message_id, attachment_id) constraint.
// ---------------------------------------------------------------------------

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024 // 500 MB size cap
const DOWNLOAD_CONCURRENCY = 2
const PAGE_LIMIT = 100

const MEDIA_EXTENSIONS = /\.(mp4|mov|webm|mkv|avi|jpg|jpeg|png|gif|webp|heic)$/i

export function isMediaAttachment(a: { content_type?: string; filename: string }): boolean {
  if (a.content_type?.startsWith('video/') || a.content_type?.startsWith('image/')) return true
  return MEDIA_EXTENSIONS.test(a.filename)
}

// --- In-memory status (the renderer polls GET /api/discord/sync/status) -----

const status: SyncStatusDto = {
  state: 'idle',
  startedAt: null,
  channels: [],
  downloads: { total: 0, completed: 0, failed: 0, skipped: 0 },
  warnings: [],
  lastResult: null,
}

export function getSyncStatus(): SyncStatusDto {
  return status
}

let running: Promise<void> | null = null

/** Fire-and-forget start; single-flight — a second call while running is a no-op. */
export function startSync(): Promise<StartSyncResult> {
  return startSyncInternal()
}

async function startSyncInternal(): Promise<StartSyncResult> {
  if (running) return { started: false, reason: 'already_running' }

  const token = await getToken()
  if (!token) return { started: false, reason: 'not_configured' }

  if ((await getPublicSettings()).tokenInvalid) {
    return { started: false, reason: 'token_invalid' }
  }

  running = runSync(token).finally(() => {
    running = null
  })
  return { started: true }
}

/** Test seam — awaits a run to completion. */
export async function runSyncToCompletion(): Promise<void> {
  const result = await startSyncInternal()
  if (result.started && running) await running
}

// --- Engine ------------------------------------------------------------------

async function runSync(token: string): Promise<void> {
  const client = createDiscordClient(token)
  const db = getDb()

  status.state = 'running'
  status.startedAt = new Date().toISOString()
  status.channels = []
  status.downloads = { total: 0, completed: 0, failed: 0, skipped: 0 }
  status.warnings = []

  let newMedia = 0
  let resultCode: 'ok' | 'unauthorized' | 'offline' | 'error' = 'ok'
  let resultMessage: string | undefined

  try {
    let channels = await db
      .selectFrom('discord_channels')
      .selectAll()
      .where('enabled', '=', 1)
      .where('sync_error', 'is', null)
      .execute()

    // Definitive Message Content Intent check via the application flags. With
    // the intent off, Discord strips content AND attachments from guild
    // messages — syncing would silently see "no media" and advance cursors
    // past real videos, losing them for good. So: warn and leave guild
    // channels (and their cursors) untouched until the coach fixes the toggle.
    // DMs are exempt from the intent and keep syncing.
    const app = await client.getCurrentApplication().catch(() => null)
    if (app && !hasMessageContentIntent(app.flags)) {
      status.warnings.push('intent_disabled')
      channels = channels.filter((c) => c.kind === 'dm')
    }

    const botUserId = await getBotUserId()

    channelLoop: for (const channel of channels) {
      const progress: SyncChannelProgress = {
        channelId: channel.id,
        name: channel.name,
        fetched: 0,
        newMedia: 0,
        done: false,
        error: null,
      }
      status.channels.push(progress)

      let cursor = channel.last_message_id

      // Athletes routinely post the video and the caption ("235 kg for 2") as
      // TWO separate Discord messages. Remember this run's text-only posts so
      // a video can adopt nearby text from the same author as its caption.
      const recentTexts: { authorId: string; timestamp: string; content: string }[] = []

      for (;;) {
        let page: DiscordMessagePayload[]
        try {
          page = await client.getMessages(channel.id, {
            after: cursor ?? undefined,
            limit: PAGE_LIMIT,
          })
        } catch (err) {
          if (err instanceof DiscordApiError && err.status === 401) {
            await markTokenInvalid(true)
            resultCode = 'unauthorized'
            progress.error = 'unauthorized'
            break channelLoop
          }
          if (err instanceof DiscordApiError && (err.status === 403 || err.status === 404)) {
            const reason = err.status === 403 ? 'forbidden' : 'not_found'
            await db
              .updateTable('discord_channels')
              .set({ sync_error: reason })
              .where('id', '=', channel.id)
              .execute()
            progress.error = reason
            break
          }
          if (err instanceof TypeError) {
            // fetch network failure — we're offline. Silent by design.
            resultCode = 'offline'
            progress.error = 'offline'
            break channelLoop
          }
          progress.error = 'error'
          resultCode = 'error'
          resultMessage = err instanceof Error ? err.message : String(err)
          break
        }

        if (page.length === 0) break

        // Discord returns newest-first; process oldest-first.
        page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))

        // Belt-and-braces intent heuristic (the flags check above is the
        // primary detector): with Message Content Intent off, Discord strips
        // BOTH content and attachments (guild channels only — DMs are exempt).
        // When a page looks stripped, do NOT advance the cursor — otherwise
        // real videos are skipped for good and a later re-sync can't recover
        // them. The channel resumes from the same spot once the coach fixes
        // the toggle.
        if (channel.kind === 'guild') {
          const nonBot = page.filter((m) => !m.author.bot)
          if (
            nonBot.length >= 3 &&
            nonBot.every((m) => m.content === '' && m.attachments.length === 0)
          ) {
            const warning = `intent_missing:${channel.name}`
            if (!status.warnings.includes(warning)) status.warnings.push(warning)
            progress.error = 'intent_missing'
            break
          }
        }

        const pageMax = page.reduce((acc, m) => maxSnowflake(acc, m.id), page[0].id)

        const added = await db.transaction().execute(async (trx) => {
          let addedInPage = 0
          for (const msg of page) {
            if (msg.author.bot || msg.author.id === botUserId) continue

            // Persist inbound DM text as the athlete side of the conversation
            // (DMs only, per product decision). Idempotent via UNIQUE.
            if (channel.kind === 'dm' && msg.content) {
              await persistInboundMessage(trx, channel.id, msg)
            }

            const mediaAttachments = msg.attachments.filter(isMediaAttachment)
            if (mediaAttachments.length === 0) {
              // Text-only post: keep it as caption context, and retro-caption
              // any captionless video this author posted moments earlier —
              // also across sync runs (the video may have synced already).
              if (msg.content) {
                recentTexts.push({
                  authorId: msg.author.id,
                  timestamp: msg.timestamp,
                  content: msg.content,
                })
                await adoptCaptionForRecentMedia(trx, channel.id, msg)
              }
              continue
            }

            await upsertDiscordUser(trx, msg.author)

            const link = await trx
              .selectFrom('discord_users')
              .select('athlete_id')
              .where('id', '=', msg.author.id)
              .executeTakeFirst()
            const athleteId = link?.athlete_id ?? null

            // No caption on the video itself → adopt the author's closest
            // text post within the adoption window (posted just before it).
            const caption = msg.content || nearestText(recentTexts, msg) || ''

            const postedDate = msg.timestamp.slice(0, 10)
            const suggested = athleteId
              ? await computeSuggestedWorkoutId(trx, athleteId, postedDate, caption)
              : null

            for (const att of mediaAttachments) {
              const inserted = await trx
                .insertInto('discord_media')
                .values({
                  id: uuidv4(),
                  channel_id: channel.id,
                  channel_name: channel.name,
                  message_id: msg.id,
                  attachment_id: att.id,
                  discord_user_id: msg.author.id,
                  athlete_id: athleteId,
                  workout_id: null,
                  suggested_workout_id: suggested,
                  filename: att.filename,
                  content_type: att.content_type ?? null,
                  size_bytes: att.size,
                  width: att.width ?? null,
                  height: att.height ?? null,
                  message_content: caption || null,
                  posted_at: msg.timestamp,
                  posted_date: postedDate,
                  source_url: att.url,
                  local_path: null,
                  sha256: null,
                  download_status: 'pending',
                  download_error: null,
                  duplicate_of_id: null,
                  reviewed: 0,
                  created_at: new Date().toISOString(),
                })
                .onConflict((oc) => oc.columns(['message_id', 'attachment_id']).doNothing())
                .executeTakeFirst()
              if ((inserted.numInsertedOrUpdatedRows ?? 0n) > 0n) addedInPage++
            }
          }

          // Cursor advances in the SAME transaction as the rows — crash-safe.
          await trx
            .updateTable('discord_channels')
            .set({ last_message_id: pageMax })
            .where('id', '=', channel.id)
            .execute()

          return addedInPage
        })

        progress.fetched += page.length
        progress.newMedia += added
        newMedia += added
        cursor = pageMax

        if (page.length < PAGE_LIMIT) break
      }

      if (!progress.error) {
        progress.done = true
        await db
          .updateTable('discord_channels')
          .set({ last_synced_at: new Date().toISOString() })
          .where('id', '=', channel.id)
          .execute()
      }
    }

    // Download phase — includes 'pending' leftovers from earlier crashed runs.
    if (resultCode === 'ok') {
      await downloadPendingMedia(client)
      // Retention sweeps — delete videos and messages past the coach's cutoffs.
      await applyRetention(await getRetentionDays()).catch(() => {})
      await applyMessageRetention(await getMessageRetentionDays()).catch(() => {})
      // Thumbnails whose owning row is already gone. Needed because deleting a
      // file can legitimately fail on Windows while it is open in the player,
      // which would otherwise strand the thumbnail on disk forever.
      await sweepOrphanThumbs().catch(() => {})
    }
  } catch (err) {
    resultCode = 'error'
    resultMessage = err instanceof Error ? err.message : String(err)
  } finally {
    status.state = 'idle'
    status.lastResult = {
      finishedAt: new Date().toISOString(),
      code: resultCode,
      newMedia,
      ...(resultMessage ? { message: resultMessage } : {}),
    }
  }
}

type DbLike = Kysely<DB> | Transaction<DB>

/**
 * Caption adoption window: a text message counts as the caption of a video
 * from the same author in the same channel when they're posted within this
 * many milliseconds of each other.
 */
const CAPTION_ADOPTION_MS = 3 * 60 * 1000

/** Closest earlier text post by the same author within the adoption window. */
function nearestText(
  recentTexts: { authorId: string; timestamp: string; content: string }[],
  msg: { author: { id: string }; timestamp: string },
): string | null {
  const msgTime = Date.parse(msg.timestamp)
  let best: { content: string; dist: number } | null = null
  for (const t of recentTexts) {
    if (t.authorId !== msg.author.id) continue
    const dist = Math.abs(msgTime - Date.parse(t.timestamp))
    if (dist <= CAPTION_ADOPTION_MS && (!best || dist < best.dist)) {
      best = { content: t.content, dist }
    }
  }
  return best?.content ?? null
}

/**
 * A text post retro-captions the author's captionless media nearby in time —
 * including media synced in an EARLIER run (video first, text a bit later,
 * sync in between). Suggestions are recomputed with the new caption unless
 * the coach already confirmed a workout.
 */
async function adoptCaptionForRecentMedia(
  trx: DbLike,
  channelId: string,
  msg: { id: string; author: { id: string }; timestamp: string; content: string },
): Promise<void> {
  const msgTime = Date.parse(msg.timestamp)
  const candidates = await trx
    .selectFrom('discord_media')
    .select(['id', 'athlete_id', 'posted_at', 'posted_date', 'workout_id'])
    .where('channel_id', '=', channelId)
    .where('discord_user_id', '=', msg.author.id)
    .where('message_content', 'is', null)
    .execute()

  for (const row of candidates) {
    if (Math.abs(msgTime - Date.parse(row.posted_at)) > CAPTION_ADOPTION_MS) continue
    const suggested =
      row.athlete_id && !row.workout_id
        ? await computeSuggestedWorkoutId(trx, row.athlete_id, row.posted_date, msg.content)
        : null
    await trx
      .updateTable('discord_media')
      .set({
        message_content: msg.content,
        ...(row.athlete_id && !row.workout_id ? { suggested_workout_id: suggested } : {}),
      })
      .where('id', '=', row.id)
      .execute()
  }
}

/** Stores one inbound DM text message (the athlete side of the conversation). */
async function persistInboundMessage(
  trx: DbLike,
  channelId: string,
  msg: DiscordMessagePayload,
): Promise<void> {
  const link = await trx
    .selectFrom('discord_users')
    .select('athlete_id')
    .where('id', '=', msg.author.id)
    .executeTakeFirst()
  await trx
    .insertInto('discord_inbound_messages')
    .values({
      id: uuidv4(),
      discord_message_id: msg.id,
      channel_id: channelId,
      discord_user_id: msg.author.id,
      athlete_id: link?.athlete_id ?? null,
      content: msg.content,
      posted_at: msg.timestamp,
      read: 0,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.column('discord_message_id').doNothing())
    .execute()
}

async function upsertDiscordUser(
  trx: DbLike,
  author: { id: string; username: string; global_name?: string | null; avatar?: string | null },
): Promise<void> {
  await trx
    .insertInto('discord_users')
    .values({
      id: author.id,
      username: author.username,
      display_name: author.global_name ?? null,
      avatar_url: avatarUrl(author),
      athlete_id: null,
      linked_at: null,
      first_seen_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        username: author.username,
        display_name: author.global_name ?? null,
        avatar_url: avatarUrl(author),
      }),
    )
    .execute()
}

/**
 * Date + caption scoring against the athlete's programmed workouts.
 * Exported for reuse by the media service (retro-linking, recompute-on-read).
 */
export async function computeSuggestedWorkoutId(
  db: DbLike,
  athleteId: string,
  postedDate: string,
  caption: string | null,
): Promise<string | null> {
  const rows = await db
    .selectFrom('workouts')
    .innerJoin('programs', 'programs.id', 'workouts.program_id')
    .leftJoin('exercises', 'exercises.workout_id', 'workouts.id')
    .select([
      'workouts.id as workout_id',
      'workouts.scheduled_date as scheduled_date',
      'exercises.name as ex_name',
      'exercises.weight as ex_weight',
      'exercises.load_used as ex_load_used',
      'exercises.reps as ex_reps',
    ])
    .where('programs.athlete_id', '=', athleteId)
    .where('workouts.scheduled_date', 'is not', null)
    .execute()

  const byWorkout = new Map<string, CandidateWorkout>()
  for (const row of rows) {
    if (!row.scheduled_date) continue
    // The scorer only looks ±3 days; prefilter to a week either side.
    if (Math.abs(Date.parse(row.scheduled_date) - Date.parse(postedDate)) > 7 * 86_400_000) continue
    let cand = byWorkout.get(row.workout_id)
    if (!cand) {
      cand = { workoutId: row.workout_id, scheduledDate: row.scheduled_date, exercises: [] }
      byWorkout.set(row.workout_id, cand)
    }
    if (row.ex_name) {
      cand.exercises.push({
        name: row.ex_name,
        weight: row.ex_weight,
        load_used: row.ex_load_used,
        reps: row.ex_reps,
      })
    }
  }

  return suggestWorkout([...byWorkout.values()], parseCaption(caption), postedDate)
}

// --- Downloads ---------------------------------------------------------------

async function downloadPendingMedia(client: DiscordClient): Promise<void> {
  const db = getDb()
  const pending = await db
    .selectFrom('discord_media')
    .selectAll()
    .where('download_status', '=', 'pending')
    .execute()

  status.downloads.total = pending.length
  if (pending.length === 0) return

  const queue = [...pending]
  const workers = Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      await downloadOne(client, item.id)
    }
  })
  await Promise.all(workers)
}

/** Downloads a single media row; used by the sync run and the retry endpoint. */
export async function downloadOne(client: DiscordClient, mediaId: string): Promise<void> {
  const db = getDb()
  const row = await db
    .selectFrom('discord_media')
    .selectAll()
    .where('id', '=', mediaId)
    .executeTakeFirst()
  if (!row) return

  if (row.size_bytes > MAX_DOWNLOAD_BYTES) {
    await db
      .updateTable('discord_media')
      .set({ download_status: 'skipped_too_large', download_error: null })
      .where('id', '=', row.id)
      .execute()
    status.downloads.skipped++
    return
  }

  const relPath = discordMediaRelPath(row.posted_at, row.message_id, row.attachment_id, row.filename)
  const absPath = resolveMediaAbsPath(relPath)

  const attempt = async (url: string) => downloadToFile(url, absPath, { maxBytes: MAX_DOWNLOAD_BYTES })

  try {
    let result: { sha256: string; bytes: number }
    try {
      if (!row.source_url) throw new MediaDownloadError(404)
      result = await attempt(row.source_url)
    } catch (err) {
      // CDN URLs are signed and expire (~24h). Re-fetch the message once for a
      // fresh URL; if the message itself is gone, record that specifically.
      if (err instanceof MediaDownloadError && (err.status === 403 || err.status === 404)) {
        let fresh
        try {
          fresh = await client.getMessage(row.channel_id, row.message_id)
        } catch (refetchErr) {
          if (refetchErr instanceof DiscordApiError && refetchErr.status === 404) {
            await markFailed(row.id, 'message_deleted')
            return
          }
          throw refetchErr
        }
        const att = fresh.attachments.find((a) => a.id === row.attachment_id)
        if (!att) {
          await markFailed(row.id, 'message_deleted')
          return
        }
        await db
          .updateTable('discord_media')
          .set({ source_url: att.url })
          .where('id', '=', row.id)
          .execute()
        result = await attempt(att.url)
      } else {
        throw err
      }
    }

    // sha256 dedupe: mark re-posts (same file, e.g. posted in two channels).
    // Both files are kept on disk so purge/delete logic never has shared paths.
    const dup = await db
      .selectFrom('discord_media')
      .select('id')
      .where('sha256', '=', result.sha256)
      .where('download_status', '=', 'downloaded')
      .where('id', '!=', row.id)
      .executeTakeFirst()

    await db
      .updateTable('discord_media')
      .set({
        local_path: relPath,
        sha256: result.sha256,
        size_bytes: result.bytes,
        download_status: 'downloaded',
        download_error: null,
        duplicate_of_id: dup?.id ?? null,
      })
      .where('id', '=', row.id)
      .execute()
    status.downloads.completed++
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      await db
        .updateTable('discord_media')
        .set({ download_status: 'skipped_too_large', download_error: null })
        .where('id', '=', row.id)
        .execute()
      status.downloads.skipped++
      return
    }
    const reason =
      err instanceof MediaDownloadError
        ? err.status === 403 || err.status === 404
          ? 'expired'
          : 'http_4xx'
        : 'network'
    await markFailed(row.id, reason)
  }
}

async function markFailed(mediaId: string, reason: string): Promise<void> {
  await getDb()
    .updateTable('discord_media')
    .set({ download_status: 'failed', download_error: reason })
    .where('id', '=', mediaId)
    .execute()
  status.downloads.failed++
}

/** Retry a failed/skipped download from the UI. */
export async function retryDownload(mediaId: string): Promise<void> {
  const token = await getToken()
  if (!token) throw new Error('Discord is not configured')
  const db = getDb()
  await db
    .updateTable('discord_media')
    .set({ download_status: 'pending', download_error: null })
    .where('id', '=', mediaId)
    .execute()
  await downloadOne(createDiscordClient(token), mediaId)
}

// --- DM channels ---------------------------------------------------------------

/**
 * Opens (or reuses) the bot↔user DM channel and registers it as a synced
 * channel. Called when a Discord user is linked to an athlete — from then on,
 * videos the athlete DMs to the bot are picked up by the normal sync loop.
 */
export async function ensureDmChannel(discordUserId: string): Promise<void> {
  const token = await getToken()
  if (!token) return
  const db = getDb()

  const user = await db
    .selectFrom('discord_users')
    .selectAll()
    .where('id', '=', discordUserId)
    .executeTakeFirst()
  if (!user) return

  const existing = await db
    .selectFrom('discord_channels')
    .select('id')
    .where('kind', '=', 'dm')
    .where('dm_user_id', '=', discordUserId)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('discord_channels')
      .set({ enabled: 1, sync_error: null })
      .where('id', '=', existing.id)
      .execute()
    return
  }

  const client = createDiscordClient(token)
  const dm = await client.createDm(discordUserId)

  await db
    .insertInto('discord_channels')
    .values({
      id: dm.id,
      kind: 'dm',
      guild_id: null,
      name: `DM · ${user.display_name ?? user.username}`,
      guild_name: null,
      dm_user_id: discordUserId,
      enabled: 1,
      last_message_id: null,
      last_synced_at: null,
      sync_error: null,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({ enabled: 1, sync_error: null, dm_user_id: discordUserId }),
    )
    .execute()
}

/** Disables the DM channel when a user is unlinked from their athlete. */
export async function disableDmChannel(discordUserId: string): Promise<void> {
  await getDb()
    .updateTable('discord_channels')
    .set({ enabled: 0 })
    .where('kind', '=', 'dm')
    .where('dm_user_id', '=', discordUserId)
    .execute()
}

// --- Startup wiring (called from electron main via electron-entry) -------------

let autoSyncTimer: ReturnType<typeof setInterval> | null = null

/**
 * Launch sync (delayed so app startup isn't blocked) + optional interval sync.
 * Lives here rather than in createApp so tests never trigger network at
 * construction; main.ts calls it after configureSecureStore.
 */
export function initAutoSync(opts?: { launchDelayMs?: number }): void {
  const delay = opts?.launchDelayMs ?? 8000
  setTimeout(() => {
    void startSync()
    void applyAutoSyncInterval()
  }, delay).unref?.()
}

/** (Re)creates the interval timer from current settings. Called after saves. */
export async function applyAutoSyncInterval(): Promise<void> {
  const settings = await getPublicSettings()
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer)
    autoSyncTimer = null
  }
  if (settings.configured && settings.autoSyncEnabled && settings.autoSyncMinutes > 0) {
    autoSyncTimer = setInterval(() => void startSync(), settings.autoSyncMinutes * 60_000)
    autoSyncTimer.unref?.()
  }
}

export function stopAutoSync(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer)
    autoSyncTimer = null
  }
}
