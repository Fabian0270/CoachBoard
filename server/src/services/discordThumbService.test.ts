import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import {
  saveThumbnail,
  markThumbStatus,
  sweepOrphanThumbs,
  getThumbAbsPath,
} from './discordThumbService.js'
import { deleteMedia, applyRetention, listMedia } from './discordMediaService.js'
import { writeMediaFile } from './mediaStore.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-thumb-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})

afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const now = () => new Date().toISOString()
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

async function createMedia(postedAt = '2026-07-03T10:00:00.000Z'): Promise<string> {
  const db = getDb()
  await db.insertInto('discord_users').values({
    id: 'u1', username: 'u1', display_name: null, avatar_url: null,
    athlete_id: null, linked_at: null, first_seen_at: now(),
  }).onConflict((oc) => oc.column('id').doNothing()).execute()

  const id = uuidv4()
  const relPath = `media/discord/2026-07/${id}.mp4`
  await writeMediaFile(relPath, Buffer.from('video-bytes'))
  await db.insertInto('discord_media').values({
    id, channel_id: 'c1', channel_name: '#form-checks',
    message_id: `m-${id}`, attachment_id: `a-${id}`, discord_user_id: 'u1',
    filename: 'lift.mp4', content_type: 'video/mp4', size_bytes: 11,
    posted_at: postedAt, posted_date: postedAt.slice(0, 10),
    local_path: relPath, sha256: 'x'.repeat(64),
    download_status: 'downloaded', reviewed: 0, created_at: now(),
  }).execute()
  return id
}

describe('saveThumbnail', () => {
  it('writes the file and records path, duration and measured dimensions', async () => {
    const id = await createMedia()
    expect(await saveThumbnail(id, JPEG, { width: 1080, height: 1920, durationMs: 8200 })).toBe(true)

    const row = await getDb().selectFrom('discord_media').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.thumb_path).toBe(`media/thumbs/2026-07/${id}.jpg`)
    expect(row.thumb_status).toBe('ok')
    expect(row.duration_ms).toBe(8200)
    expect(row.width).toBe(1080)
    expect(row.height).toBe(1920)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'thumbs', '2026-07', `${id}.jpg`))).toBe(true)
  })

  it('never overwrites known dimensions with nulls', async () => {
    const id = await createMedia()
    await saveThumbnail(id, JPEG, { width: 1080, height: 1920, durationMs: 1000 })
    await saveThumbnail(id, JPEG, { width: null, height: null, durationMs: 1000 })

    const row = await getDb().selectFrom('discord_media').select(['width', 'height']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.width).toBe(1080)
    expect(row.height).toBe(1920)
  })

  it('returns false for an unknown media id rather than writing a stray file', async () => {
    expect(await saveThumbnail(uuidv4(), JPEG, { width: null, height: null, durationMs: null })).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'thumbs'))).toBe(false)
  })
})

describe('markThumbStatus', () => {
  // This is what stops a tile re-attempting an impossible decode on every scroll.
  it('persists the failure so the client can stop retrying', async () => {
    const id = await createMedia()
    expect(await markThumbStatus(id, 'unsupported')).toBe(true)

    const { items } = await listMedia({ filter: 'all' })
    expect(items[0].thumbStatus).toBe('unsupported')
    expect(items[0].thumbUrl).toBeNull()
  })

  it('reports a miss for an unknown id', async () => {
    expect(await markThumbStatus(uuidv4(), 'failed')).toBe(false)
  })
})

describe('thumbnail cleanup', () => {
  const thumbExists = (id: string) =>
    fs.existsSync(path.join(tmpDir, 'media', 'thumbs', '2026-07', `${id}.jpg`))

  it('deleteMedia removes the thumbnail alongside the video', async () => {
    const id = await createMedia()
    await saveThumbnail(id, JPEG, { width: 100, height: 100, durationMs: 1000 })
    expect(thumbExists(id)).toBe(true)

    await deleteMedia(id)
    expect(thumbExists(id)).toBe(false)
  })

  it('the retention sweep spares videos that have a saved analysis', async () => {
    // An analysis is deliberate work, not cache. Expiring the footage under it
    // would leave a saved bar path no one could check against its own video.
    const kept = await createMedia('2020-07-03T10:00:00.000Z')
    const swept = await createMedia('2020-07-03T10:00:00.000Z')
    await getDb().insertInto('video_analyses').values({
      id: uuidv4(), media_id: kept, athlete_id: null, source_label: 'squat',
      track: JSON.stringify([{ t: 0, x: 1, y: 2 }]), calibration: null,
      metrics: null, notes: null, created_at: now(), updated_at: now(),
    }).execute()

    await applyRetention(30)

    const left = await getDb().selectFrom('discord_media').select('id').execute()
    expect(left.map((r) => r.id)).toEqual([kept])
    expect(left.map((r) => r.id)).not.toContain(swept)
  })

  it('the retention sweep removes thumbnails too', async () => {
    const id = await createMedia('2020-07-03T10:00:00.000Z')
    await saveThumbnail(id, JPEG, { width: 100, height: 100, durationMs: 1000 })
    const old = path.join(tmpDir, 'media', 'thumbs', '2020-07', `${id}.jpg`)
    expect(fs.existsSync(old)).toBe(true)

    await applyRetention(30)
    expect(fs.existsSync(old)).toBe(false)
  })
})

describe('sweepOrphanThumbs', () => {
  // Deleting a file can legitimately fail on Windows while the player holds it
  // open, so an unclaimed thumbnail would otherwise sit on disk forever.
  it('removes thumbnails no row claims and keeps the ones that are claimed', async () => {
    const id = await createMedia()
    await saveThumbnail(id, JPEG, { width: 100, height: 100, durationMs: 1000 })
    await writeMediaFile('media/thumbs/2026-07/orphan.jpg', JPEG)

    expect(await sweepOrphanThumbs()).toBe(1)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'thumbs', '2026-07', 'orphan.jpg'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'thumbs', '2026-07', `${id}.jpg`))).toBe(true)
  })

  it('leaves in-flight .part writes alone', async () => {
    fs.mkdirSync(path.join(tmpDir, 'media', 'thumbs', '2026-07'), { recursive: true })
    const part = path.join(tmpDir, 'media', 'thumbs', '2026-07', 'x.jpg.part')
    fs.writeFileSync(part, JPEG)

    expect(await sweepOrphanThumbs()).toBe(0)
    expect(fs.existsSync(part)).toBe(true)
  })

  it('is a no-op before any thumbnail exists', async () => {
    expect(await sweepOrphanThumbs()).toBe(0)
  })
})

describe('getThumbAbsPath', () => {
  it('resolves inside the media root once a thumbnail exists', async () => {
    const id = await createMedia()
    expect(await getThumbAbsPath(id)).toBeNull()

    await saveThumbnail(id, JPEG, { width: 100, height: 100, durationMs: 1000 })
    const abs = await getThumbAbsPath(id)
    expect(abs).toBe(path.join(tmpDir, 'media', 'thumbs', '2026-07', `${id}.jpg`))
  })
})
