import { describe, it, expect, vi } from 'vitest'
import {
  createDiscordClient,
  DiscordApiError,
  snowflakeFromDate,
  dateFromSnowflake,
  maxSnowflake,
} from './discordApiClient.js'

const TOKEN = 'test-bot-token-abcdefghijklmnop'

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
}

describe('snowflake helpers', () => {
  it('round-trips a date through a snowflake', () => {
    const d = new Date('2026-07-03T12:00:00.000Z')
    expect(dateFromSnowflake(snowflakeFromDate(d)).getTime()).toBe(d.getTime())
  })

  it('the Discord epoch maps to snowflake 0', () => {
    expect(snowflakeFromDate(new Date(1420070400000))).toBe('0')
  })

  it('maxSnowflake compares numerically, not lexicographically', () => {
    // '9' > '10' as strings — BigInt comparison must win.
    expect(maxSnowflake('9', '10')).toBe('10')
    expect(maxSnowflake('999999999999999999', '1000000000000000000')).toBe('1000000000000000000')
  })
})

describe('createDiscordClient', () => {
  it('sends the bot Authorization header and parses JSON', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`)
      return jsonResponse({ id: '42', username: 'coachbot' })
    })
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    const me = await client.getCurrentUser()
    expect(me.username).toBe('coachbot')
  })

  it('retries on 429 using retry_after, then succeeds', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return jsonResponse({ retry_after: 0.01 }, { status: 429 })
      return jsonResponse({ id: '42', username: 'coachbot' })
    })
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    const me = await client.getCurrentUser()
    expect(me.id).toBe('42')
    expect(calls).toBe(2)
  })

  it('throws a typed error on 401/403/404 without leaking the token', async () => {
    for (const status of [401, 403, 404]) {
      const fetchImpl = vi.fn(async () => jsonResponse({ code: 0 }, { status }))
      const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
      const err = await client.getCurrentUser().catch((e) => e)
      expect(err).toBeInstanceOf(DiscordApiError)
      expect((err as DiscordApiError).status).toBe(status)
      expect((err as Error).message).not.toContain(TOKEN)
    }
  })

  it('waits out an exhausted rate-limit bucket before returning', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([], {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.01' },
      }),
    )
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    const start = Date.now()
    await client.getGuilds()
    expect(Date.now() - start).toBeGreaterThanOrEqual(5)
  })

  it('filters guild channels to text/announcement and sorts by position', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { id: 'v', type: 2, name: 'voice', position: 0 },
        { id: 'b', type: 0, name: 'general', position: 2 },
        { id: 'a', type: 5, name: 'announcements', position: 1 },
      ]),
    )
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    const channels = await client.getGuildChannels('g1')
    expect(channels.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('sendMessage builds a reply with message_reference and no mentions', async () => {
    let sentBody: Record<string, unknown> = {}
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      return jsonResponse({ id: 'm1' })
    })
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    await client.sendMessage('c1', 'Nice depth!', 'orig-msg')
    expect(sentBody.content).toBe('Nice depth!')
    expect(sentBody.allowed_mentions).toEqual({ parse: [] })
    expect((sentBody.message_reference as { message_id: string }).message_id).toBe('orig-msg')

    await client.sendMessage('c1', 'plain')
    const plain = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
    expect(plain.message_reference).toBeUndefined()
  })

  it('getMessages passes after + limit as query params', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('/channels/c1/messages?')
      expect(String(url)).toContain('limit=100')
      expect(String(url)).toContain('after=123')
      return jsonResponse([])
    })
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    await client.getMessages('c1', { after: '123', limit: 100 })
  })
})

describe('sendMessageWithFile', () => {
  // Multipart is the one genuinely new capability Feature 11c needed from this
  // client, and the failure mode is quiet: a malformed body uploads the file but
  // leaves the message without it, or Discord rejects a hand-written boundary.

  it('sends multipart and lets fetch set the boundary itself', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      // Setting this by hand omits the boundary and Discord cannot parse it.
      expect(headers['Content-Type']).toBeUndefined()
      expect(headers.Authorization).toBe(`Bot ${TOKEN}`)
      expect(init?.body).toBeInstanceOf(FormData)
      return jsonResponse({ id: 'm1' })
    })
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    const sent = await client.sendMessageWithFile('c1', 'here you go', {
      filename: 'feedback.webm',
      contentType: 'video/webm',
      data: Buffer.from('video-bytes'),
    })
    expect(sent.id).toBe('m1')
  })

  it('references the upload from the message, or Discord orphans the file', async () => {
    let form: FormData | undefined
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      form = init?.body as FormData
      return jsonResponse({ id: 'm1' })
    })
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    await client.sendMessageWithFile('c1', 'watch this', {
      filename: 'feedback.webm',
      contentType: 'video/webm',
      data: Buffer.from('video-bytes'),
    })

    const payload = JSON.parse(form!.get('payload_json') as string)
    expect(payload.content).toBe('watch this')
    // The attachments entry is what binds files[0] to the message.
    expect(payload.attachments).toEqual([{ id: 0, filename: 'feedback.webm' }])
    // Same no-pings rule as every other CoachBoard message.
    expect(payload.allowed_mentions).toEqual({ parse: [] })

    const file = form!.get('files[0]') as File
    expect(file.type).toBe('video/webm')
    expect(await file.text()).toBe('video-bytes')
  })

  it('still sends plain messages as JSON', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
      expect(typeof init?.body).toBe('string')
      return jsonResponse({ id: 'm2' })
    })
    const client = createDiscordClient(TOKEN, fetchImpl as unknown as typeof fetch)
    await client.sendMessage('c1', 'no file here')
  })
})
