// ---------------------------------------------------------------------------
// Minimal Discord REST client — plain fetch against /api/v10, no discord.js.
// Runs only in the server (Electron main process). Sequential use everywhere,
// so a single header-aware backoff is enough; no rate-limit bucket map needed.
//
// SECURITY: the bot token must never appear in error messages or logs — the
// Express global error handler logs err.message, so DiscordApiError is
// constructed from status + Discord error code only.
// ---------------------------------------------------------------------------

const API_BASE = 'https://discord.com/api/v10'
const DISCORD_EPOCH_MS = 1420070400000n

/** Snowflake for a point in time — used to seed cursors from a history window. */
export function snowflakeFromDate(d: Date): string {
  const ms = BigInt(Math.max(d.getTime(), 1420070400000))
  return ((ms - DISCORD_EPOCH_MS) << 22n).toString()
}

/** ISO timestamp encoded in a snowflake (UTC). */
export function dateFromSnowflake(snowflake: string): Date {
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS))
}

/** BigInt-safe max — snowflakes must never be compared as strings or Numbers. */
export function maxSnowflake(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b
}

export class DiscordApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    // Deliberately terse: no URLs, no headers, no token.
    super(`Discord API error ${status}${code ? ` (${code})` : ''}`)
    this.name = 'DiscordApiError'
  }
}

export interface DiscordUserPayload {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
  bot?: boolean
}

export interface DiscordAttachmentPayload {
  id: string
  filename: string
  content_type?: string
  size: number
  url: string
  width?: number | null
  height?: number | null
}

export interface DiscordMessagePayload {
  id: string
  channel_id: string
  author: DiscordUserPayload
  content: string
  timestamp: string
  attachments: DiscordAttachmentPayload[]
}

export interface DiscordGuildPayload {
  id: string
  name: string
}

export interface DiscordChannelPayload {
  id: string
  name?: string
  type: number
  position?: number
}

export interface DiscordGuildMemberPayload {
  user?: DiscordUserPayload
  nick?: string | null
}

/**
 * Application flag bits for the Message Content intent:
 * GATEWAY_MESSAGE_CONTENT (1<<18, enabled) | GATEWAY_MESSAGE_CONTENT_LIMITED
 * (1<<19, enabled but app unverified). Either bit set = the portal toggle is on.
 */
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19)

export function hasMessageContentIntent(flags: number | undefined): boolean {
  // Fail open when Discord doesn't send flags — the per-page heuristic still guards.
  if (typeof flags !== 'number') return true
  return (flags & MESSAGE_CONTENT_FLAGS) !== 0
}

export function avatarUrl(user: DiscordUserPayload): string | null {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : null
}

export interface DiscordClient {
  /** GET /users/@me — validates the token, returns the bot's own user. */
  getCurrentUser(): Promise<DiscordUserPayload>
  /** GET /applications/@me — Application ID for the invite URL + intent flags. */
  getCurrentApplication(): Promise<{ id: string; name: string; flags?: number }>
  getGuilds(): Promise<DiscordGuildPayload[]>
  /** Text (0) and announcement (5) channels only, sorted by position. */
  getGuildChannels(guildId: string): Promise<DiscordChannelPayload[]>
  getMessages(
    channelId: string,
    opts: { after?: string; limit?: number },
  ): Promise<DiscordMessagePayload[]>
  /** Re-fetch one message — used to refresh an expired attachment CDN URL. */
  getMessage(channelId: string, messageId: string): Promise<DiscordMessagePayload>
  /** POST /users/@me/channels — opens (or returns the existing) DM channel. */
  createDm(recipientId: string): Promise<{ id: string }>
  sendMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
  ): Promise<{ id: string }>
  /** Same, with one file attached. See MAX_ATTACHMENT_BYTES before calling. */
  sendMessageWithFile(
    channelId: string,
    content: string,
    file: { filename: string; contentType: string; data: Buffer },
  ): Promise<{ id: string }>
  searchGuildMembers(guildId: string, query: string): Promise<DiscordGuildMemberPayload[]>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createDiscordClient(token: string, fetchImpl: typeof fetch = fetch): DiscordClient {
  async function request<T>(
    method: string,
    apiPath: string,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    // FormData carries file uploads. Its Content-Type must be left unset so
    // fetch can generate the multipart boundary — setting it by hand produces a
    // body Discord cannot parse. Everything else is JSON as before.
    const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData

    const res = await fetchImpl(`${API_BASE}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'CoachBoard (https://github.com/Fabian0270/CoachBoard, local)',
        ...(body !== undefined && !isMultipart ? { 'Content-Type': 'application/json' } : {}),
      },
      body: isMultipart
        ? (body as FormData)
        : body !== undefined
          ? JSON.stringify(body)
          : undefined,
    })

    if (res.status === 429 && attempt < 5) {
      const payload = (await res.json().catch(() => ({}))) as { retry_after?: number }
      await sleep(Math.ceil((payload.retry_after ?? 1) * 1000))
      return request<T>(method, apiPath, body, attempt + 1)
    }

    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { code?: number | string }
      throw new DiscordApiError(res.status, payload.code != null ? String(payload.code) : '')
    }

    // Preemptive backoff: if this bucket is exhausted, wait it out before returning
    // so the sequential caller never trips a 429 in the first place.
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const resetAfter = Number(res.headers.get('x-ratelimit-reset-after') ?? '0')
      if (resetAfter > 0) await sleep(Math.ceil(resetAfter * 1000))
    }

    return (await res.json()) as T
  }

  return {
    getCurrentUser: () => request<DiscordUserPayload>('GET', '/users/@me'),
    getCurrentApplication: () =>
      request<{ id: string; name: string; flags?: number }>('GET', '/applications/@me'),
    getGuilds: () => request<DiscordGuildPayload[]>('GET', '/users/@me/guilds'),
    getGuildChannels: async (guildId) => {
      const channels = await request<DiscordChannelPayload[]>(
        'GET',
        `/guilds/${guildId}/channels`,
      )
      return channels
        .filter((c) => c.type === 0 || c.type === 5)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    },
    getMessages: (channelId, opts) => {
      const params = new URLSearchParams({ limit: String(opts.limit ?? 100) })
      if (opts.after) params.set('after', opts.after)
      return request<DiscordMessagePayload[]>(
        'GET',
        `/channels/${channelId}/messages?${params}`,
      )
    },
    getMessage: (channelId, messageId) =>
      request<DiscordMessagePayload>('GET', `/channels/${channelId}/messages/${messageId}`),
    createDm: (recipientId) =>
      request<{ id: string }>('POST', '/users/@me/channels', { recipient_id: recipientId }),
    sendMessage: (channelId, content, replyToMessageId) =>
      request<{ id: string }>('POST', `/channels/${channelId}/messages`, {
        content,
        // Never ping anyone from a CoachBoard reply.
        allowed_mentions: { parse: [] },
        ...(replyToMessageId
          ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } }
          : {}),
      }),
    sendMessageWithFile: (channelId, content, file) => {
      const form = new FormData()
      // Discord takes the message itself as a payload_json part, with each file
      // in files[n] and a matching entry in `attachments` keyed by the same
      // index. Omitting the attachments entry uploads the file but leaves it
      // unreferenced by the message.
      form.append(
        'payload_json',
        JSON.stringify({
          content,
          allowed_mentions: { parse: [] },
          attachments: [{ id: 0, filename: file.filename }],
        }),
      )
      form.append(
        'files[0]',
        new Blob([new Uint8Array(file.data)], { type: file.contentType }),
        file.filename,
      )
      return request<{ id: string }>('POST', `/channels/${channelId}/messages`, form)
    },
    searchGuildMembers: (guildId, query) => {
      const params = new URLSearchParams({ query, limit: '10' })
      return request<DiscordGuildMemberPayload[]>(
        'GET',
        `/guilds/${guildId}/members/search?${params}`,
      )
    },
  }
}
