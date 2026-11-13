import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { createApp } from '../app.js'
import { initializeDatabase, getDb } from '../db.js'

// Ids from a request become path segments of authenticated Discord API calls,
// so anything but a snowflake must be refused before it gets near the client.

let server: Server
let base: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  server = createApp().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/discord`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('Discord ids', () => {
  // A bare '..' is not listed: fetch resolves it client-side before sending, so
  // it never reaches this route. Encoded inside a segment, it does.
  it.each(['-1', 'abc', '1 2', '123/../users'])('refuses guild id %j', async (id) => {
    const res = await fetch(`${base}/guilds/${encodeURIComponent(id)}/channels`)
    expect(res.status).toBe(400)
  })

  it('refuses a channel whose ids are not snowflakes, and stores nothing', async () => {
    const res = await fetch(`${base}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: '../../users/@me', guildId: '1', name: '#x', historyDays: 30 }),
    })
    expect(res.status).toBe(400)
    expect(await getDb().selectFrom('discord_channels').selectAll().execute()).toHaveLength(0)
  })

  it('accepts real snowflakes', async () => {
    const res = await fetch(`${base}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '1180000000000000001', guildId: '1180000000000000000', name: '#form-checks', historyDays: 30,
      }),
    })
    expect(res.status).toBe(201)
  })
})
