import express, { Router } from 'express'
import { z } from 'zod'
import {
  saveThumbnail,
  markThumbStatus,
  getThumbAbsPath,
} from '../services/discordThumbService.js'
import {
  getPublicSettings,
  saveToken,
  setAutoSync,
  setRetentionDays,
  setMessageRetentionDays,
  getToken,
  DiscordSettingsError,
} from '../services/discordSettingsService.js'
import {
  createDiscordClient,
  DiscordApiError,
  snowflakeFromDate,
  avatarUrl,
  hasMessageContentIntent,
} from '../services/discordApiClient.js'
import {
  getSyncStatus,
  startSync,
  retryDownload,
  applyAutoSyncInterval,
} from '../services/discordSyncService.js'
import {
  listMedia,
  getMediaRow,
  getMediaItem,
  getInboxCounts,
  getStorageUsage,
  deleteMedia,
  linkUser,
  assignMediaToAthlete,
  setMediaWorkout,
  setReviewed,
  listUsers,
  listWorkoutCandidates,
  disconnect,
  clearCache,
  getAthleteConversation,
  markConversationRead,
  listUnreadThreads,
} from '../services/discordMediaService.js'
import { replyToMedia, dmAthlete, listSentForMedia, DiscordSendError } from '../services/discordSendService.js'
import { resolveMediaAbsPath } from '../services/mediaStore.js'
import { getDb } from '../db.js'
import type { ConfiguredChannelDto } from 'coachboard-shared/discord'

const router = Router()

// All Discord API calls stay server-side; the bot token never leaves this
// process. The ONLY route that ever receives it is PUT /settings/token.

async function requireClient() {
  const token = await getToken()
  if (!token) return null
  return createDiscordClient(token)
}

function discordErrorStatus(err: unknown): { status: number; error: string } {
  if (err instanceof DiscordApiError) {
    if (err.status === 401) {
      return { status: 400, error: 'The bot token is no longer valid — reconnect Discord.' }
    }
    return { status: 502, error: `Discord returned an error (HTTP ${err.status}).` }
  }
  if (err instanceof TypeError) {
    return { status: 503, error: "You're offline — Discord can't be reached right now." }
  }
  return { status: 500, error: 'Unexpected Discord error' }
}

// --- Settings ----------------------------------------------------------------

router.get('/settings', async (_req, res) => {
  res.json(await getPublicSettings())
})

const tokenSchema = z.object({ token: z.string().trim().min(20, 'Paste the full bot token') })

router.put('/settings/token', async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid token' })
    return
  }
  try {
    const client = createDiscordClient(parsed.data.token)
    const [me, app] = [await client.getCurrentUser(), await client.getCurrentApplication()]
    const saved = await saveToken(parsed.data.token, {
      applicationId: app.id,
      botUserId: me.id,
      botUsername: me.username,
    })
    // Surface the intent state so the wizard can warn before the coach proceeds
    // (this is the setup mistake that silently breaks syncing).
    res.json({ ...saved, messageContentIntent: hasMessageContentIntent(app.flags) })
  } catch (err) {
    if (err instanceof DiscordSettingsError) {
      res.status(400).json({ error: err.message })
      return
    }
    if (err instanceof DiscordApiError && err.status === 401) {
      res.status(400).json({
        error:
          "That token wasn't accepted by Discord. In the Developer Portal, open your app → Bot → Reset Token, and paste the new one.",
      })
      return
    }
    const mapped = discordErrorStatus(err)
    res.status(mapped.status).json({ error: mapped.error })
  }
})

const autoSyncSchema = z.object({
  enabled: z.boolean(),
  minutes: z.coerce.number().int().min(1).max(24 * 60),
})

router.put('/settings/auto-sync', async (req, res) => {
  const parsed = autoSyncSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' })
    return
  }
  const saved = await setAutoSync(parsed.data)
  await applyAutoSyncInterval()
  res.json(saved)
})

const retentionSchema = z.object({ days: z.coerce.number().int().min(0).max(3650) })

router.put('/settings/retention', async (req, res) => {
  const parsed = retentionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid retention setting' })
    return
  }
  res.json(await setRetentionDays(parsed.data.days))
})

router.put('/settings/message-retention', async (req, res) => {
  const parsed = retentionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid retention setting' })
    return
  }
  res.json(await setMessageRetentionDays(parsed.data.days))
})

// Manual "free up space" purge — deletes videos + messages older than N days.
router.post('/clear-cache', async (req, res) => {
  const parsed = retentionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid age' })
    return
  }
  res.json(await clearCache(parsed.data.days))
})

// --- Guild / channel discovery (live from Discord, for the wizard) ------------

router.get('/guilds', async (_req, res) => {
  const client = await requireClient()
  if (!client) {
    res.status(400).json({ error: 'Discord is not configured' })
    return
  }
  try {
    res.json(await client.getGuilds())
  } catch (err) {
    const mapped = discordErrorStatus(err)
    res.status(mapped.status).json({ error: mapped.error })
  }
})

router.get('/guilds/:guildId/channels', async (req, res) => {
  const client = await requireClient()
  if (!client) {
    res.status(400).json({ error: 'Discord is not configured' })
    return
  }
  try {
    const [channels, configured] = await Promise.all([
      client.getGuildChannels(req.params.guildId),
      getDb().selectFrom('discord_channels').select('id').execute(),
    ])
    const configuredIds = new Set(configured.map((c) => c.id))
    res.json(
      channels.map((c) => ({
        id: c.id,
        name: c.name ?? c.id,
        alreadyConfigured: configuredIds.has(c.id),
      })),
    )
  } catch (err) {
    const mapped = discordErrorStatus(err)
    res.status(mapped.status).json({ error: mapped.error })
  }
})

router.get('/guilds/:guildId/members/search', async (req, res) => {
  const client = await requireClient()
  if (!client) {
    res.status(400).json({ error: 'Discord is not configured' })
    return
  }
  const query = String(req.query.q ?? '').trim()
  if (!query) {
    res.json([])
    return
  }
  try {
    const members = await client.searchGuildMembers(req.params.guildId, query)
    res.json(
      members
        .filter((m) => m.user && !m.user.bot)
        .map((m) => ({
          userId: m.user!.id,
          username: m.user!.username,
          displayName: m.nick ?? m.user!.global_name ?? null,
          avatarUrl: avatarUrl(m.user!),
        })),
    )
  } catch (err) {
    const mapped = discordErrorStatus(err)
    res.status(mapped.status).json({ error: mapped.error })
  }
})

// --- Configured channels -------------------------------------------------------

function toChannelDto(row: {
  id: string
  kind: string
  guild_id: string | null
  name: string
  guild_name: string | null
  dm_user_id: string | null
  enabled: number
  last_synced_at: string | null
  sync_error: string | null
}): ConfiguredChannelDto {
  return {
    id: row.id,
    kind: row.kind as ConfiguredChannelDto['kind'],
    guildId: row.guild_id,
    name: row.name,
    guildName: row.guild_name,
    dmUserId: row.dm_user_id,
    enabled: row.enabled === 1,
    lastSyncedAt: row.last_synced_at,
    syncError: row.sync_error as ConfiguredChannelDto['syncError'],
  }
}

router.get('/channels', async (_req, res) => {
  const rows = await getDb().selectFrom('discord_channels').selectAll().orderBy('created_at').execute()
  res.json(rows.map(toChannelDto))
})

const addChannelSchema = z.object({
  channelId: z.string().min(1),
  guildId: z.string().min(1),
  name: z.string().min(1),
  guildName: z.string().optional().default(''),
  historyDays: z.union([z.literal(30), z.literal(90), z.null()]),
})

router.post('/channels', async (req, res) => {
  const parsed = addChannelSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid channel' })
    return
  }
  const { channelId, guildId, name, guildName, historyDays } = parsed.data

  // History window → pre-seeded cursor: null days = full history (cursor '0').
  const cursor = historyDays
    ? snowflakeFromDate(new Date(Date.now() - historyDays * 86_400_000))
    : '0'

  await getDb()
    .insertInto('discord_channels')
    .values({
      id: channelId,
      kind: 'guild',
      guild_id: guildId,
      name,
      guild_name: guildName || null,
      dm_user_id: null,
      enabled: 1,
      last_message_id: cursor,
      last_synced_at: null,
      sync_error: null,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.column('id').doUpdateSet({ enabled: 1, sync_error: null }))
    .execute()

  const row = await getDb()
    .selectFrom('discord_channels')
    .selectAll()
    .where('id', '=', channelId)
    .executeTakeFirstOrThrow()
  res.status(201).json(toChannelDto(row))
})

const patchChannelSchema = z.object({ enabled: z.boolean() })

router.patch('/channels/:id', async (req, res) => {
  const parsed = patchChannelSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid channel update' })
    return
  }
  const result = await getDb()
    .updateTable('discord_channels')
    .set({
      enabled: parsed.data.enabled ? 1 : 0,
      // Re-enabling is the coach saying "try again" after a permissions fix.
      ...(parsed.data.enabled ? { sync_error: null } : {}),
    })
    .where('id', '=', req.params.id)
    .executeTakeFirst()
  if ((result.numUpdatedRows ?? 0n) === 0n) {
    res.status(404).json({ error: 'Channel not found' })
    return
  }
  const row = await getDb()
    .selectFrom('discord_channels')
    .selectAll()
    .where('id', '=', req.params.id)
    .executeTakeFirstOrThrow()
  res.json(toChannelDto(row))
})

router.delete('/channels/:id', async (req, res) => {
  // Config-only delete: already-synced media keeps its opaque channel_id.
  await getDb().deleteFrom('discord_channels').where('id', '=', req.params.id).execute()
  res.json({ ok: true })
})

// --- Sync ----------------------------------------------------------------------

router.post('/sync', async (_req, res) => {
  res.json(await startSync())
})

router.get('/sync/status', (_req, res) => {
  res.json(getSyncStatus())
})

// --- Media ----------------------------------------------------------------------

const listMediaSchema = z.object({
  filter: z.enum(['unmatched', 'unreviewed', 'all']).optional(),
  athleteId: z.string().optional(),
  programId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

router.get('/media', async (req, res) => {
  const parsed = listMediaSchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid media query' })
    return
  }
  res.json(await listMedia(parsed.data))
})

router.get('/media/counts', async (_req, res) => {
  res.json(await getInboxCounts())
})

router.get('/media/storage', async (_req, res) => {
  res.json(await getStorageUsage())
})

// Registered after /media/counts and /media/storage so those literal paths win;
// Express matches in order and :id would otherwise swallow them.
router.get('/media/:id', async (req, res) => {
  const item = await getMediaItem(req.params.id)
  if (!item) {
    res.status(404).json({ error: 'Media not found' })
    return
  }
  res.json(item)
})

router.delete('/media/:id', async (req, res) => {
  const deleted = await deleteMedia(req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'Media not found' })
    return
  }
  res.json({ ok: true })
})

router.get('/media/:id/file', async (req, res) => {
  const row = await getMediaRow(req.params.id)
  if (!row || row.download_status !== 'downloaded' || !row.local_path) {
    res.status(404).json({ error: 'File not available' })
    return
  }
  // sendFile handles Range/206 natively — required for video seeking.
  res.sendFile(resolveMediaAbsPath(row.local_path), {
    acceptRanges: true,
    headers: { 'Content-Type': row.content_type ?? 'application/octet-stream' },
  })
})

// --- Thumbnails (Feature 11a) ----------------------------------------------
// Generated in the renderer (see client thumbnailQueue) because Chromium already
// decodes the video; shipping ffmpeg just to grab one frame would cost ~80 MB per
// platform on the installer and on every auto-update.

router.get('/media/:id/thumb', async (req, res) => {
  const abs = await getThumbAbsPath(req.params.id)
  if (!abs) {
    res.status(404).json({ error: 'No thumbnail' })
    return
  }
  res.sendFile(abs, {
    headers: {
      'Content-Type': 'image/jpeg',
      // The path is keyed by media id and only ever rewritten by an explicit
      // regenerate, so the browser can hold it indefinitely.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

const thumbMetaSchema = z.object({
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  durationMs: z.coerce.number().nonnegative().optional(),
})

// express.json() is installed globally in app.ts but only parses
// application/json, so a raw parser has to be mounted per-route for binary
// bodies — same shape as the restore upload in routes/backup.ts.
router.post(
  '/media/:id/thumbnail',
  express.raw({ type: 'image/jpeg', limit: '2mb' }),
  async (req, res) => {
    const body = req.body
    // The bytes come from our own renderer, but this route writes to disk, so
    // it verifies rather than trusts: JPEG SOI marker, non-empty.
    if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
      res.status(400).json({ error: 'Expected a JPEG body' })
      return
    }
    const parsed = thumbMetaSchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid thumbnail metadata' })
      return
    }
    const saved = await saveThumbnail(req.params.id, body, {
      width: parsed.data.width ?? null,
      height: parsed.data.height ?? null,
      durationMs: parsed.data.durationMs ?? null,
    })
    if (!saved) {
      res.status(404).json({ error: 'Media not found' })
      return
    }
    res.json(await getMediaItem(req.params.id))
  },
)

const thumbStatusSchema = z.object({ status: z.enum(['unsupported', 'failed']) })

/**
 * Records that this machine could not produce a thumbnail. Persisting the
 * failure is what stops the tile re-attempting an impossible decode (HEVC with
 * no platform decoder) on every scroll.
 */
router.post('/media/:id/thumbnail/status', async (req, res) => {
  const parsed = thumbStatusSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid thumbnail status' })
    return
  }
  const ok = await markThumbStatus(req.params.id, parsed.data.status)
  if (!ok) {
    res.status(404).json({ error: 'Media not found' })
    return
  }
  res.json(await getMediaItem(req.params.id))
})

const assignSchema = z.object({ athleteId: z.string().nullable() })

router.post('/media/:id/assign', async (req, res) => {
  const parsed = assignSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid assignment' })
    return
  }
  await assignMediaToAthlete(req.params.id, parsed.data.athleteId)
  res.json(await getMediaItem(req.params.id))
})

const workoutSchema = z.object({ workoutId: z.string().nullable() })

router.post('/media/:id/workout', async (req, res) => {
  const parsed = workoutSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid workout attach' })
    return
  }
  await setMediaWorkout(req.params.id, parsed.data.workoutId)
  res.json(await getMediaItem(req.params.id))
})

const reviewedSchema = z.object({ reviewed: z.boolean() })

router.post('/media/:id/reviewed', async (req, res) => {
  const parsed = reviewedSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid reviewed flag' })
    return
  }
  await setReviewed(req.params.id, parsed.data.reviewed)
  res.json(await getMediaItem(req.params.id))
})

router.post('/media/:id/retry-download', async (req, res) => {
  try {
    await retryDownload(req.params.id)
    res.json(await getMediaItem(req.params.id))
  } catch (err) {
    const mapped = discordErrorStatus(err)
    res.status(mapped.status).json({ error: mapped.error })
  }
})

router.get('/media/:id/workout-candidates', async (req, res) => {
  res.json(await listWorkoutCandidates(req.params.id))
})

// --- Two-way messaging -----------------------------------------------------------

const replySchema = z.object({
  content: z.string().trim().min(1, 'Write a message first').max(2000),
  via: z.enum(['channel', 'dm']),
})

router.post('/media/:id/reply', async (req, res) => {
  const parsed = replySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid message' })
    return
  }
  try {
    res.json(await replyToMedia(req.params.id, parsed.data.content, parsed.data.via))
  } catch (err) {
    if (err instanceof DiscordSendError) {
      res.status(400).json({ error: err.message })
      return
    }
    const mapped = discordErrorStatus(err)
    res.status(mapped.status).json({ error: mapped.error })
  }
})

router.get('/media/:id/sent', async (req, res) => {
  res.json(await listSentForMedia(req.params.id))
})

const dmSchema = z.object({ content: z.string().trim().min(1, 'Write a message first').max(2000) })

router.post('/athletes/:athleteId/dm', async (req, res) => {
  const parsed = dmSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid message' })
    return
  }
  try {
    res.json(await dmAthlete(req.params.athleteId, parsed.data.content))
  } catch (err) {
    if (err instanceof DiscordSendError) {
      res.status(400).json({ error: err.message })
      return
    }
    const mapped = discordErrorStatus(err)
    res.status(mapped.status).json({ error: mapped.error })
  }
})

// Per-athlete DM conversation (inbound + outbound, oldest first).
router.get('/athletes/:athleteId/messages', async (req, res) => {
  res.json(await getAthleteConversation(req.params.athleteId))
})

router.post('/athletes/:athleteId/messages/read', async (req, res) => {
  await markConversationRead(req.params.athleteId)
  res.json({ ok: true })
})

// Athletes with unread inbound DMs (Inbox → Messages tab).
router.get('/messages/unread', async (_req, res) => {
  res.json(await listUnreadThreads())
})

// --- Users / linking ---------------------------------------------------------------

router.get('/users', async (req, res) => {
  res.json(await listUsers({ unlinkedOnly: req.query.unlinkedOnly === 'true' }))
})

const linkSchema = z.object({ athleteId: z.string().nullable() })

router.post('/users/:id/link', async (req, res) => {
  const parsed = linkSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid link' })
    return
  }
  res.json(await linkUser(req.params.id, parsed.data.athleteId))
})

// --- Disconnect ----------------------------------------------------------------------

const disconnectSchema = z.object({ purge: z.boolean() })

router.post('/disconnect', async (req, res) => {
  const parsed = disconnectSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid disconnect request' })
    return
  }
  res.json(await disconnect(parsed.data))
})

export default router
