import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore, type SafeStorageLike } from './secureStore.js'
import { saveToken } from './discordSettingsService.js'
import { replyToMedia, dmAthlete, listSentForMedia, DiscordSendError } from './discordSendService.js'

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
}

let tmpDir: string
let requests: { url: string; body: Record<string, unknown> }[]

const now = () => new Date().toISOString()

function stubDiscord(opts?: { failSendWith?: number }) {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      requests.push({ url: u, body })
      if (u.endsWith('/users/@me/channels')) {
        return new Response(JSON.stringify({ id: 'dm-chan-1' }), { status: 200 })
      }
      if (/\/channels\/[^/]+\/messages$/.test(u)) {
        if (opts?.failSendWith) {
          return new Response(JSON.stringify({ code: 50007 }), { status: opts.failSendWith })
        }
        return new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }),
  )
}

async function seedMedia(): Promise<{ mediaId: string; athleteId: string }> {
  const db = getDb()
  const athleteId = uuidv4()
  await db.insertInto('athletes').values({
    id: athleteId, name: 'Anna', email: null, sport: null, date_of_birth: null,
    notes: null, archived: 0, created_at: now(), updated_at: now(),
  }).execute()
  await db.insertInto('discord_users').values({
    id: 'u1', username: 'anna_lifts', display_name: null, avatar_url: null,
    athlete_id: athleteId, linked_at: now(), first_seen_at: now(),
  }).execute()
  const mediaId = uuidv4()
  await db.insertInto('discord_media').values({
    id: mediaId, channel_id: 'chan-src', channel_name: '#form-checks',
    message_id: 'orig-msg', attachment_id: 'a1', discord_user_id: 'u1',
    athlete_id: athleteId, workout_id: null, suggested_workout_id: null,
    filename: 'v.mp4', content_type: 'video/mp4', size_bytes: 1, width: null, height: null,
    message_content: null, posted_at: now(), posted_date: now().slice(0, 10),
    source_url: null, local_path: null, sha256: null,
    download_status: 'downloaded', download_error: null, duplicate_of_id: null,
    reviewed: 0, created_at: now(),
  }).execute()
  return { mediaId, athleteId }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-send-'))
  configureSecureStore({ safeStorage: fakeSafeStorage, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
  await saveToken('send-test-token-1234567890', {
    applicationId: 'app1', botUserId: 'bot1', botUsername: 'coachbot',
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  // Close the sqlite handle before deleting the temp dir (Windows EBUSY).
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('replyToMedia', () => {
  it('channel reply threads to the original message and logs "sent"', async () => {
    stubDiscord()
    const { mediaId } = await seedMedia()

    const dto = await replyToMedia(mediaId, 'Great depth — add 2.5 kg', 'channel')
    expect(dto.status).toBe('sent')
    expect(dto.kind).toBe('channel')

    const send = requests.find((r) => r.url.includes('/channels/chan-src/messages'))
    expect(send).toBeDefined()
    expect((send!.body.message_reference as { message_id: string }).message_id).toBe('orig-msg')

    const log = await listSentForMedia(mediaId)
    expect(log).toHaveLength(1)
    expect(log[0].status).toBe('sent')
  })

  it('DM reply opens the DM channel and sends without a message_reference', async () => {
    stubDiscord()
    const { mediaId } = await seedMedia()

    const dto = await replyToMedia(mediaId, 'Sent you notes', 'dm')
    expect(dto.status).toBe('sent')

    const dmOpen = requests.find((r) => r.url.endsWith('/users/@me/channels'))
    expect(dmOpen?.body.recipient_id).toBe('u1')
    const send = requests.find((r) => r.url.includes('/channels/dm-chan-1/messages'))
    expect(send?.body.message_reference).toBeUndefined()
  })

  it('a Discord 403 logs "failed" with a friendly privacy explanation (no throw)', async () => {
    stubDiscord({ failSendWith: 403 })
    const { mediaId } = await seedMedia()

    const dto = await replyToMedia(mediaId, 'hello', 'dm')
    expect(dto.status).toBe('failed')
    expect(dto.error).toContain('privacy')

    const log = await listSentForMedia(mediaId)
    expect(log[0].status).toBe('failed')
  })
})

describe('dmAthlete', () => {
  it('DMs the linked account and logs it', async () => {
    stubDiscord()
    const { athleteId } = await seedMedia()

    const dto = await dmAthlete(athleteId, 'Week 3 looks strong!')
    expect(dto.status).toBe('sent')
    const send = requests.find((r) => r.url.includes('/channels/dm-chan-1/messages'))
    expect(send?.body.content).toBe('Week 3 looks strong!')
  })

  it('rejects when the athlete has no linked Discord account', async () => {
    stubDiscord()
    await expect(dmAthlete(uuidv4(), 'hi')).rejects.toBeInstanceOf(DiscordSendError)
  })
})
