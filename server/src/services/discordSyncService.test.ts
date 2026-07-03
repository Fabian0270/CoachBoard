import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore, type SafeStorageLike } from './secureStore.js'
import { saveToken } from './discordSettingsService.js'
import {
  runSyncToCompletion,
  getSyncStatus,
  startSync,
  isMediaAttachment,
} from './discordSyncService.js'

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
}

const API = 'https://discord.com/api/v10'
const CDN = 'https://cdn.example/attachments'

interface FakeAttachment {
  id: string
  filename: string
  content_type?: string
  size: number
  url: string
}
interface FakeMessage {
  id: string
  channel_id: string
  author: { id: string; username: string; bot?: boolean }
  content: string
  timestamp: string
  attachments: FakeAttachment[]
}

/** Per-test Discord fake: message store per channel + CDN byte store. */
class FakeDiscord {
  messages = new Map<string, FakeMessage[]>()
  files = new Map<string, Buffer>()
  failNextMessagesFetch = false
  forbidden = new Set<string>()
  /** GATEWAY_MESSAGE_CONTENT set by default; 0 simulates the toggle being off. */
  appFlags = 1 << 18

  handler = async (url: RequestInfo | URL): Promise<Response> => {
    const u = String(url)

    if (u.startsWith(CDN)) {
      const body = this.files.get(u)
      if (!body) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(body), { status: 200 })
    }

    if (u === `${API}/applications/@me`) {
      return new Response(
        JSON.stringify({ id: 'app1', name: 'CoachBoard Helper', flags: this.appFlags }),
        { status: 200 },
      )
    }

    const pageMatch = u.match(new RegExp(`^${API}/channels/([^/]+)/messages\\?(.+)$`))
    if (pageMatch) {
      if (this.failNextMessagesFetch) {
        this.failNextMessagesFetch = false
        throw new TypeError('fetch failed')
      }
      const channelId = pageMatch[1]
      if (this.forbidden.has(channelId)) {
        return new Response(JSON.stringify({ code: 50001 }), { status: 403 })
      }
      const params = new URLSearchParams(pageMatch[2])
      const after = BigInt(params.get('after') ?? '0')
      const limit = Number(params.get('limit') ?? '100')
      const all = (this.messages.get(channelId) ?? [])
        .filter((m) => BigInt(m.id) > after)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .slice(0, limit)
      return new Response(JSON.stringify(all), { status: 200 })
    }

    const singleMatch = u.match(new RegExp(`^${API}/channels/([^/]+)/messages/([^/?]+)$`))
    if (singleMatch) {
      const msg = (this.messages.get(singleMatch[1]) ?? []).find((m) => m.id === singleMatch[2])
      if (!msg) return new Response(JSON.stringify({ code: 10008 }), { status: 404 })
      return new Response(JSON.stringify(msg), { status: 200 })
    }

    return new Response(JSON.stringify({}), { status: 404 })
  }
}

let tmpDir: string
let fake: FakeDiscord

const addChannel = async (id: string, opts?: { kind?: string; cursor?: string | null }) => {
  await getDb()
    .insertInto('discord_channels')
    .values({
      id,
      kind: opts?.kind ?? 'guild',
      guild_id: opts?.kind === 'dm' ? null : 'g1',
      name: opts?.kind === 'dm' ? `DM · user` : `#${id}`,
      guild_name: null,
      dm_user_id: null,
      enabled: 1,
      last_message_id: opts?.cursor ?? '0',
      last_synced_at: null,
      sync_error: null,
      created_at: new Date().toISOString(),
    })
    .execute()
}

const videoMsg = (
  id: string,
  channelId: string,
  body: Buffer,
  opts?: { author?: string; content?: string; filename?: string; timestamp?: string },
): FakeMessage => {
  const url = `${CDN}/${channelId}/${id}.mp4`
  fake.files.set(url, body)
  return {
    id,
    channel_id: channelId,
    author: { id: opts?.author ?? 'u1', username: opts?.author ?? 'u1' },
    content: opts?.content ?? '',
    timestamp: opts?.timestamp ?? '2026-07-03T10:00:00.000Z',
    attachments: [
      {
        id: `a${id}`,
        filename: opts?.filename ?? 'video.mp4',
        content_type: 'video/mp4',
        size: body.length,
        url,
      },
    ],
  }
}

const textMsg = (
  id: string,
  channelId: string,
  content: string,
  opts?: { author?: string; timestamp?: string },
): FakeMessage => ({
  id,
  channel_id: channelId,
  author: { id: opts?.author ?? 'u1', username: opts?.author ?? 'u1' },
  content,
  timestamp: opts?.timestamp ?? '2026-07-03T10:00:30.000Z',
  attachments: [],
})

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sync-'))
  configureSecureStore({ safeStorage: fakeSafeStorage, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
  await saveToken('sync-test-token-1234567890', {
    applicationId: 'app1',
    botUserId: 'bot-self',
    botUsername: 'coachbot',
  })
  fake = new FakeDiscord()
  vi.stubGlobal('fetch', vi.fn(fake.handler))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  // Close the sqlite handle before deleting the temp dir (Windows EBUSY).
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('isMediaAttachment', () => {
  it('accepts video/image content types and known extensions', () => {
    expect(isMediaAttachment({ content_type: 'video/mp4', filename: 'x' })).toBe(true)
    expect(isMediaAttachment({ content_type: 'image/png', filename: 'x' })).toBe(true)
    expect(isMediaAttachment({ filename: 'clip.MOV' })).toBe(true)
    expect(isMediaAttachment({ content_type: 'application/pdf', filename: 'notes.pdf' })).toBe(false)
  })
})

describe('discordSyncService', () => {
  it('refuses to start when unconfigured', async () => {
    fs.rmSync(path.join(tmpDir, 'discord-settings.json'))
    expect(await startSync()).toEqual({ started: false, reason: 'not_configured' })
  })

  it('syncs media messages, skips bots and text-only, advances the cursor, downloads files', async () => {
    await addChannel('c1')
    fake.messages.set('c1', [
      videoMsg('101', 'c1', Buffer.from('video-bytes-1'), { content: '180 kg for 2' }),
      {
        id: '102',
        channel_id: 'c1',
        author: { id: 'u2', username: 'chatty' },
        content: 'nice lift!',
        timestamp: '2026-07-03T10:01:00.000Z',
        attachments: [],
      },
      {
        id: '103',
        channel_id: 'c1',
        author: { id: 'b1', username: 'otherbot', bot: true },
        content: '',
        timestamp: '2026-07-03T10:02:00.000Z',
        attachments: [],
      },
    ])

    await runSyncToCompletion()

    const media = await getDb().selectFrom('discord_media').selectAll().execute()
    expect(media).toHaveLength(1)
    expect(media[0].message_content).toBe('180 kg for 2')
    expect(media[0].download_status).toBe('downloaded')
    expect(media[0].sha256).toBeTruthy()
    expect(media[0].local_path).toContain('media/discord/2026-07/')
    expect(fs.existsSync(path.join(tmpDir, media[0].local_path!))).toBe(true)

    const channel = await getDb()
      .selectFrom('discord_channels').selectAll().where('id', '=', 'c1').executeTakeFirstOrThrow()
    expect(channel.last_message_id).toBe('103') // cursor advances past bot/text messages too

    // The video's author was upserted; the chatty user too (only media authors matter,
    // but upsert happens per media message — chatty has no media, so only u1 exists).
    const users = await getDb().selectFrom('discord_users').selectAll().execute()
    expect(users.map((u) => u.id)).toEqual(['u1'])

    expect(getSyncStatus().lastResult?.code).toBe('ok')
    expect(getSyncStatus().lastResult?.newMedia).toBe(1)
  })

  it('re-running is idempotent (UNIQUE + cursor)', async () => {
    await addChannel('c1')
    fake.messages.set('c1', [videoMsg('201', 'c1', Buffer.from('bytes'))])

    await runSyncToCompletion()
    await runSyncToCompletion()

    const media = await getDb().selectFrom('discord_media').selectAll().execute()
    expect(media).toHaveLength(1)
  })

  it('a network failure mid-run persists the cursor; the re-run completes without duplicates', async () => {
    await addChannel('c1')
    // 100 messages → full page → engine requests page 2, which we fail.
    const msgs: FakeMessage[] = []
    for (let i = 1; i <= 100; i++) {
      msgs.push(
        i % 50 === 0
          ? videoMsg(String(1000 + i), 'c1', Buffer.from(`v${i}`))
          : {
              id: String(1000 + i),
              channel_id: 'c1',
              author: { id: 'u1', username: 'u1' },
              content: `msg ${i}`,
              timestamp: '2026-07-03T10:00:00.000Z',
              attachments: [],
            },
      )
    }
    msgs.push(videoMsg('1200', 'c1', Buffer.from('page2-video')))
    fake.messages.set('c1', msgs)

    // Page 1 succeeds; page 2 throws (offline).
    let pageCount = 0
    const realHandler = fake.handler
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes('/messages?')) {
          pageCount++
          if (pageCount === 2) throw new TypeError('fetch failed')
        }
        return realHandler(url)
      }),
    )

    await runSyncToCompletion()
    const afterCrash = await getDb()
      .selectFrom('discord_channels').selectAll().where('id', '=', 'c1').executeTakeFirstOrThrow()
    expect(afterCrash.last_message_id).toBe('1100') // end of page 1, committed with its rows
    expect(getSyncStatus().lastResult?.code).toBe('offline')

    // Back online: only page-2 content is new.
    vi.stubGlobal('fetch', vi.fn(fake.handler))
    await runSyncToCompletion()

    const media = await getDb().selectFrom('discord_media').selectAll().execute()
    expect(media).toHaveLength(3) // 2 from page 1, 1 from page 2 — no duplicates
    expect(getSyncStatus().lastResult?.code).toBe('ok')
  })

  it('403 disables one channel and keeps syncing the next', async () => {
    await addChannel('c1')
    await addChannel('c2')
    fake.forbidden.add('c1')
    fake.messages.set('c2', [videoMsg('301', 'c2', Buffer.from('ok-bytes'))])

    await runSyncToCompletion()

    const c1 = await getDb()
      .selectFrom('discord_channels').selectAll().where('id', '=', 'c1').executeTakeFirstOrThrow()
    expect(c1.sync_error).toBe('forbidden')

    const media = await getDb().selectFrom('discord_media').selectAll().execute()
    expect(media).toHaveLength(1)
    expect(media[0].channel_id).toBe('c2')
  })

  it('flags the stripped-page pattern on guild channels only and freezes the cursor', async () => {
    await addChannel('c1')
    await addChannel('dm1', { kind: 'dm' })
    const empty = (channelId: string, id: string): FakeMessage => ({
      id,
      channel_id: channelId,
      author: { id: 'u1', username: 'u1' },
      content: '',
      timestamp: '2026-07-03T10:00:00.000Z',
      attachments: [],
    })
    fake.messages.set('c1', Array.from({ length: 12 }, (_, i) => empty('c1', String(500 + i))))
    fake.messages.set('dm1', Array.from({ length: 12 }, (_, i) => empty('dm1', String(700 + i))))

    await runSyncToCompletion()

    const warnings = getSyncStatus().warnings
    expect(warnings).toContain('intent_missing:#c1')
    expect(warnings.filter((w) => w.includes('dm'))).toHaveLength(0)

    // The stripped page must NOT advance the cursor — once the coach enables
    // the intent, a re-sync starts from the same spot and recovers everything.
    const c1 = await getDb()
      .selectFrom('discord_channels').selectAll().where('id', '=', 'c1').executeTakeFirstOrThrow()
    expect(c1.last_message_id).toBe('0')
  })

  it('detects the disabled intent via application flags and pauses guild sync entirely', async () => {
    await addChannel('c1')
    fake.appFlags = 0 // Message Content Intent toggle is off in the portal
    // Discord would strip these — but the flags check must stop us before any fetch.
    fake.messages.set('c1', [videoMsg('601', 'c1', Buffer.from('bytes'))])

    await runSyncToCompletion()

    expect(getSyncStatus().warnings).toContain('intent_disabled')
    const c1 = await getDb()
      .selectFrom('discord_channels').selectAll().where('id', '=', 'c1').executeTakeFirstOrThrow()
    expect(c1.last_message_id).toBe('0') // untouched
    expect(await getDb().selectFrom('discord_media').selectAll().execute()).toHaveLength(0)

    // Toggle fixed → the same messages sync fine on the next run.
    fake.appFlags = 1 << 18
    await runSyncToCompletion()
    expect(await getDb().selectFrom('discord_media').selectAll().execute()).toHaveLength(1)
  })

  it('marks re-posted identical files as duplicates (both kept)', async () => {
    await addChannel('c1')
    const bytes = Buffer.from('same-video-bytes')
    fake.messages.set('c1', [
      videoMsg('401', 'c1', bytes),
      videoMsg('402', 'c1', bytes, { filename: 'repost.mp4' }),
    ])

    await runSyncToCompletion()

    const media = await getDb()
      .selectFrom('discord_media').selectAll().orderBy('message_id').execute()
    expect(media).toHaveLength(2)
    const dups = media.filter((m) => m.duplicate_of_id !== null)
    expect(dups).toHaveLength(1)
    expect(media.every((m) => m.download_status === 'downloaded')).toBe(true)
  })

  it('adopts a separate text message posted right AFTER the video as its caption', async () => {
    await addChannel('c1')
    fake.messages.set('c1', [
      videoMsg('801', 'c1', Buffer.from('v'), { timestamp: '2026-07-03T10:00:00.000Z' }),
      textMsg('802', 'c1', 'deadlift 235 kg for 2', { timestamp: '2026-07-03T10:00:40.000Z' }),
    ])

    await runSyncToCompletion()

    const media = await getDb().selectFrom('discord_media').selectAll().executeTakeFirstOrThrow()
    expect(media.message_content).toBe('deadlift 235 kg for 2')
  })

  it('adopts a text message posted right BEFORE the video', async () => {
    await addChannel('c1')
    fake.messages.set('c1', [
      textMsg('810', 'c1', 'squat 180x2 @8', { timestamp: '2026-07-03T09:59:30.000Z' }),
      videoMsg('811', 'c1', Buffer.from('v'), { timestamp: '2026-07-03T10:00:00.000Z' }),
    ])

    await runSyncToCompletion()

    const media = await getDb().selectFrom('discord_media').selectAll().executeTakeFirstOrThrow()
    expect(media.message_content).toBe('squat 180x2 @8')
  })

  it('backfills the caption when the text arrives in a LATER sync run', async () => {
    await addChannel('c1')
    fake.messages.set('c1', [
      videoMsg('820', 'c1', Buffer.from('v'), { timestamp: '2026-07-03T10:00:00.000Z' }),
    ])
    await runSyncToCompletion()

    let media = await getDb().selectFrom('discord_media').selectAll().executeTakeFirstOrThrow()
    expect(media.message_content).toBeNull()

    // The athlete types the caption a minute later; next sync picks it up.
    fake.messages.get('c1')!.push(
      textMsg('821', 'c1', 'bench 100 för 5', { timestamp: '2026-07-03T10:01:00.000Z' }),
    )
    await runSyncToCompletion()

    media = await getDb().selectFrom('discord_media').selectAll().executeTakeFirstOrThrow()
    expect(media.message_content).toBe('bench 100 för 5')
  })

  it('does not adopt text that is too far away in time or from another author', async () => {
    await addChannel('c1')
    fake.messages.set('c1', [
      videoMsg('830', 'c1', Buffer.from('v'), { timestamp: '2026-07-03T10:00:00.000Z' }),
      textMsg('831', 'c1', 'ten minutes later', { timestamp: '2026-07-03T10:10:00.000Z' }),
      textMsg('832', 'c1', 'someone else', {
        author: 'u2',
        timestamp: '2026-07-03T10:00:20.000Z',
      }),
    ])

    await runSyncToCompletion()

    const media = await getDb().selectFrom('discord_media').selectAll().executeTakeFirstOrThrow()
    expect(media.message_content).toBeNull()
  })

  it('skips oversized attachments without fetching them', async () => {
    await addChannel('c1')
    const msg = videoMsg('501', 'c1', Buffer.from('tiny'))
    msg.attachments[0].size = 600 * 1024 * 1024 // metadata says 600 MB
    fake.messages.set('c1', [msg])

    await runSyncToCompletion()

    const media = await getDb().selectFrom('discord_media').selectAll().executeTakeFirstOrThrow()
    expect(media.download_status).toBe('skipped_too_large')
    expect(media.local_path).toBeNull()
  })
})
