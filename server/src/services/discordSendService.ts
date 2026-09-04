import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { createDiscordClient, DiscordApiError } from './discordApiClient.js'
import { getToken } from './discordSettingsService.js'
import type { SentMessageDto } from 'coachboard-shared/discord'

// ---------------------------------------------------------------------------
// Outbound messages (two-way, manual only): reply to a video in its source
// channel (a real Discord reply threaded to the original message) or DM the
// athlete. Every attempt is logged to discord_sent_messages — success or not.
// ---------------------------------------------------------------------------

export class DiscordSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscordSendError'
  }
}

function toDto(row: {
  id: string
  kind: string
  content: string
  status: string
  error: string | null
  created_at: string
}): SentMessageDto {
  return {
    id: row.id,
    kind: row.kind as SentMessageDto['kind'],
    content: row.content,
    status: row.status as SentMessageDto['status'],
    error: row.error,
    createdAt: row.created_at,
  }
}

async function logAttempt(entry: {
  channelId: string
  kind: 'channel' | 'dm'
  discordUserId: string | null
  relatedMediaId: string | null
  replyToMessageId: string | null
  content: string
  status: 'sent' | 'failed'
  error: string | null
  discordMessageId: string | null
}): Promise<SentMessageDto> {
  const row = {
    id: uuidv4(),
    channel_id: entry.channelId,
    kind: entry.kind,
    discord_user_id: entry.discordUserId,
    related_media_id: entry.relatedMediaId,
    reply_to_message_id: entry.replyToMessageId,
    content: entry.content,
    status: entry.status,
    error: entry.error,
    discord_message_id: entry.discordMessageId,
    created_at: new Date().toISOString(),
  }
  await getDb().insertInto('discord_sent_messages').values(row).execute()
  return toDto(row)
}

function friendlySendError(err: unknown): string {
  if (err instanceof DiscordApiError) {
    if (err.status === 403) {
      return "Discord blocked the message — the athlete's privacy settings may not allow DMs from the bot, or the bot lost channel permissions. Try replying in the channel instead."
    }
    if (err.status === 401) return 'The bot token is no longer valid — reconnect Discord in Settings.'
    if (err.status === 404) return 'The channel or message no longer exists on Discord.'
    return `Discord rejected the message (HTTP ${err.status}).`
  }
  if (err instanceof TypeError) return "You're offline — the message was not sent."
  return 'The message could not be sent.'
}

/** Reply to a synced video: into its source channel, or as a DM to the author. */
export async function replyToMedia(
  mediaId: string,
  content: string,
  via: 'channel' | 'dm',
): Promise<SentMessageDto> {
  const token = await getToken()
  if (!token) throw new DiscordSendError('Discord is not configured')

  const media = await getDb()
    .selectFrom('discord_media')
    .select(['id', 'channel_id', 'message_id', 'discord_user_id'])
    .where('id', '=', mediaId)
    .executeTakeFirst()
  if (!media) throw new DiscordSendError('Media not found')

  const client = createDiscordClient(token)

  let channelId = media.channel_id
  let replyToMessageId: string | null = media.message_id
  try {
    if (via === 'dm') {
      const dm = await client.createDm(media.discord_user_id)
      channelId = dm.id
      // The original message lives in another channel — a cross-channel
      // message_reference is invalid, so a DM reply is a plain message.
      replyToMessageId = null
    }
    const sent = await client.sendMessage(channelId, content, replyToMessageId ?? undefined)
    return await logAttempt({
      channelId,
      kind: via,
      discordUserId: media.discord_user_id,
      relatedMediaId: media.id,
      replyToMessageId,
      content,
      status: 'sent',
      error: null,
      discordMessageId: sent.id,
    })
  } catch (err) {
    return await logAttempt({
      channelId,
      kind: via,
      discordUserId: media.discord_user_id,
      relatedMediaId: media.id,
      replyToMessageId,
      content,
      status: 'failed',
      error: friendlySendError(err),
      discordMessageId: null,
    })
  }
}

/**
 * Discord's attachment ceiling for a bot on an unboosted server.
 *
 * Not the 25 MB a Nitro user sees — the bot is neither, and reading the higher
 * number off Discord's UI is an easy way to build a feature that fails only for
 * real recordings. At the recorder's bitrate this is about 47 seconds of video,
 * which is why a program walkthrough goes by email or to disk.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** The athlete's most recently active linked account, or an explanatory throw. */
async function linkedUserId(athleteId: string): Promise<string> {
  // Multiple linked accounts → prefer the one that posted most recently.
  const link = await getDb()
    .selectFrom('discord_users')
    .leftJoin('discord_media', 'discord_media.discord_user_id', 'discord_users.id')
    .select((eb) => [
      'discord_users.id as user_id',
      eb.fn.max('discord_media.posted_at').as('last_post'),
    ])
    .where('discord_users.athlete_id', '=', athleteId)
    .groupBy('discord_users.id')
    .orderBy('last_post', 'desc')
    .executeTakeFirst()
  if (!link) throw new DiscordSendError('This athlete has no linked Discord account')
  return link.user_id
}

/**
 * DMs a feedback recording to an athlete.
 *
 * The size check happens before the upload rather than after Discord rejects
 * it: a 40 MB POST that was always going to fail wastes the coach's time and
 * their bandwidth, and the error Discord returns says nothing about what to do
 * instead.
 */
export async function dmRecordingToAthlete(
  athleteId: string,
  content: string,
  file: { filename: string; contentType: string; data: Buffer },
): Promise<SentMessageDto> {
  const token = await getToken()
  if (!token) throw new DiscordSendError('Discord is not configured')
  if (file.data.length > MAX_ATTACHMENT_BYTES) {
    throw new DiscordSendError(
      'This recording is too big for Discord. Email it or save it to your PC instead.',
    )
  }

  const userId = await linkedUserId(athleteId)
  const client = createDiscordClient(token)
  try {
    const dm = await client.createDm(userId)
    const sent = await client.sendMessageWithFile(dm.id, content, file)
    return await logAttempt({
      channelId: dm.id,
      kind: 'dm',
      discordUserId: userId,
      relatedMediaId: null,
      replyToMessageId: null,
      content,
      status: 'sent',
      error: null,
      discordMessageId: sent.id,
    })
  } catch (err) {
    return await logAttempt({
      channelId: 'dm',
      kind: 'dm',
      discordUserId: userId,
      relatedMediaId: null,
      replyToMessageId: null,
      content,
      status: 'failed',
      error: friendlySendError(err),
      discordMessageId: null,
    })
  }
}

/** Free-form DM to an athlete via their linked Discord account. */
export async function dmAthlete(athleteId: string, content: string): Promise<SentMessageDto> {
  const token = await getToken()
  if (!token) throw new DiscordSendError('Discord is not configured')

  const link = { user_id: await linkedUserId(athleteId) }

  const client = createDiscordClient(token)
  try {
    const dm = await client.createDm(link.user_id)
    const sent = await client.sendMessage(dm.id, content)
    return await logAttempt({
      channelId: dm.id,
      kind: 'dm',
      discordUserId: link.user_id,
      relatedMediaId: null,
      replyToMessageId: null,
      content,
      status: 'sent',
      error: null,
      discordMessageId: sent.id,
    })
  } catch (err) {
    return await logAttempt({
      channelId: 'dm',
      kind: 'dm',
      discordUserId: link.user_id,
      relatedMediaId: null,
      replyToMessageId: null,
      content,
      status: 'failed',
      error: friendlySendError(err),
      discordMessageId: null,
    })
  }
}

/** Sent-message log for one media item (shown under the video). */
export async function listSentForMedia(mediaId: string): Promise<SentMessageDto[]> {
  const rows = await getDb()
    .selectFrom('discord_sent_messages')
    .selectAll()
    .where('related_media_id', '=', mediaId)
    .orderBy('created_at', 'asc')
    .execute()
  return rows.map(toDto)
}
