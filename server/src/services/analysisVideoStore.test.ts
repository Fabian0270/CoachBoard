import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureSecureStore } from './secureStore.js'
import {
  appendVideoChunk,
  beginVideo,
  deleteVideo,
  finishVideo,
  sweepOrphanVideos,
  videoPath,
} from './analysisVideoStore.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-av-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function store(name = 'squat.mp4', body = 'video-bytes') {
  const { id, ext } = await beginVideo(name)
  await appendVideoChunk(id, ext, Buffer.from(body))
  return { id, ext, ...(await finishVideo(id, ext)) }
}

describe('the ordinary path', () => {
  it('accumulates chunks and seals a playable file', async () => {
    const { id, ext } = await beginVideo('squat.mp4')
    expect(await appendVideoChunk(id, ext, Buffer.from('one'))).toBe(3)
    expect(await appendVideoChunk(id, ext, Buffer.from('two'))).toBe(6)

    const stored = await finishVideo(id, ext)
    expect(stored).toEqual({ relPath: `analyses/${id}.mp4`, bytes: 6 })

    const abs = await videoPath(stored.relPath)
    expect(abs).not.toBeNull()
    expect(fs.readFileSync(abs!).toString()).toBe('onetwo')
  })

  it('is not servable until it is sealed', async () => {
    const { id, ext } = await beginVideo('squat.mp4')
    await appendVideoChunk(id, ext, Buffer.from('half'))
    // A half-written file must never reach a player.
    expect(await videoPath(`analyses/${id}.mp4`)).toBeNull()
  })
})

describe('the filename is not trusted', () => {
  // The extension is the only part of a coach-supplied name that reaches the
  // path, and playback depends on it — so it is an allowlist, not a sanitiser.
  it('keeps a known video extension', async () => {
    expect((await beginVideo('lift.mov')).ext).toBe('.mov')
    expect((await beginVideo('lift.WEBM')).ext).toBe('.webm')
  })

  it('falls back to .mp4 for anything else', async () => {
    for (const name of ['lift.exe', 'lift', 'lift.tar.gz', '../../etc/passwd', '']) {
      expect((await beginVideo(name)).ext).toBe('.mp4')
    }
  })

  it('refuses an id that is not one of ours, so the path cannot be steered', async () => {
    await expect(appendVideoChunk('../../evil', '.mp4', Buffer.from('x'))).rejects.toThrow(
      'Invalid video id',
    )
  })
})

describe('refusals', () => {
  it('rejects an append to an upload that was never started', async () => {
    await expect(
      appendVideoChunk('11111111-1111-1111-1111-111111111111', '.mp4', Buffer.from('x')),
    ).rejects.toThrow('No such upload')
  })

  it('refuses to seal an upload that carried nothing', async () => {
    const { id, ext } = await beginVideo('squat.mp4')
    await expect(finishVideo(id, ext)).rejects.toThrow('empty')
    // And leaves nothing behind that would look like a video and play as none.
    expect(await videoPath(`analyses/${id}.mp4`)).toBeNull()
  })

  it('stops a runaway upload at the cap rather than filling the disk', async () => {
    const { id, ext } = await beginVideo('huge.mp4')
    const big = Buffer.alloc(1024 * 1024)
    // Force the cap without allocating 500 MB: append until it refuses.
    let threw: Error | null = null
    for (let i = 0; i < 600 && !threw; i++) {
      await appendVideoChunk(id, ext, big).catch((e: Error) => {
        threw = e
      })
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toContain('too large')
    // The partial file goes with it — half a video is not worth keeping.
    expect(fs.existsSync(path.join(tmpDir, 'media', 'analyses', `${id}.mp4.part`))).toBe(false)
  }, 30_000)
})

describe('deleting', () => {
  it('removes a stored video', async () => {
    const stored = await store()
    await deleteVideo(stored.relPath)
    expect(await videoPath(stored.relPath)).toBeNull()
  })

  it('is a no-op for an analysis that owns no copy', async () => {
    // A Discord-backed analysis has video_path null and must not throw.
    await expect(deleteVideo(null)).resolves.toBeUndefined()
    await expect(deleteVideo(undefined)).resolves.toBeUndefined()
  })

  it('refuses to delete outside the media root', async () => {
    const outside = path.join(tmpDir, 'keep-me.txt')
    fs.writeFileSync(outside, 'important')
    await deleteVideo('../../keep-me.txt')
    expect(fs.existsSync(outside)).toBe(true)
  })
})

describe('sweepOrphanVideos', () => {
  it('deletes only what no row claims', async () => {
    const kept = await store('kept.mp4')
    const orphan = await store('orphan.mp4')

    expect(await sweepOrphanVideos(new Set([kept.relPath]))).toBe(1)
    expect(await videoPath(kept.relPath)).not.toBeNull()
    expect(await videoPath(orphan.relPath)).toBeNull()
  })

  it('leaves in-flight uploads alone', async () => {
    // A .part belongs to an upload in progress, not to an orphan.
    const { id, ext } = await beginVideo('inflight.mp4')
    await appendVideoChunk(id, ext, Buffer.from('partial'))
    expect(await sweepOrphanVideos(new Set())).toBe(0)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'analyses', `${id}.mp4.part`))).toBe(true)
  })

  it('is a no-op before anything has been stored', async () => {
    expect(await sweepOrphanVideos(new Set())).toBe(0)
  })
})
