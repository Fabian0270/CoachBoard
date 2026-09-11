import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { LANDMARK_COUNT, FLOATS_PER_LANDMARK } from 'coachboard-shared/pose'
import { createApp } from '../app.js'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from '../services/secureStore.js'

// ---------------------------------------------------------------------------
// Regression: the pose feature could not save anything.
//
// express.json() was installed globally with no options, which is a 100 kb
// default. A pose track is ~238 KB for a couple of seconds, so every save past
// about ONE SECOND of footage came back 413 entity.too.large before the route's
// own schema was ever consulted — the schema meanwhile permitted ~150 MB. The
// client caught the failure and toasted "the analysis was saved, but the
// skeleton could not be", so the feature read as flaky rather than broken, and
// no skeleton was ever stored for any coach.
//
// These tests are sized in FRAMES rather than bytes on purpose: frames are what
// the caps are written in, and a test that asserted on a byte count would pass
// while the thing that actually matters — "can a realistic track be saved" —
// regressed. `requestVideoFrameCallback` samples at the video's native rate, so
// the 60 fps cases below are ordinary phone footage, not an extreme.
// ---------------------------------------------------------------------------

vi.spyOn(console, 'log').mockImplementation(() => {})

let server: Server
let baseUrl = ''
let dir = ''
let analysisId = ''

const send = async (p: string, method: string, body: unknown) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** A bar path of `n` samples, shaped exactly as the client posts it. */
const track = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ t: i / 30, x: 100 + (i % 50), y: 500 - (i % 80) }))

/** A pose payload of `frames` frames, shaped exactly as poseApi.savePose packs it. */
const posePayload = (frames: number) => {
  const floats = frames * LANDMARK_COUNT * FLOATS_PER_LANDMARK
  return {
    frameCount: frames,
    landmarkCount: LANDMARK_COUNT,
    // Real coordinates, not zeros: a Float32 value stringifies to ~18 characters
    // where 0 takes one, and that difference is most of the payload size.
    keypoints: Array.from({ length: floats }, (_, i) => (i % 1080) + 0.123456789),
    world: Array.from({ length: floats }, (_, i) => (i % 100) / 100 - 0.5),
    times: Array.from({ length: frames }, (_, i) => i / 30),
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-bodylimit-'))
  configureSecureStore({ userDataDir: dir })
  await initializeDatabase(path.join(dir, 'coachboard.sqlite'))

  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const created = await send('/api/analysis', 'POST', {
    mediaId: null,
    athleteId: null,
    sourceLabel: 'body-limit fixture',
    track: track(10),
    calibration: null,
    metrics: [],
    notes: null,
  })
  expect(created.status).toBe(201)
  analysisId = created.body.id
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  try {
    await getDb().destroy()
  } catch {
    /* already closed */
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pose track body size', () => {
  it('stores a one-second track — the size that used to 413', async () => {
    // 30 frames serialises to ~112 KB, just past the old 100 kb default. This is
    // the smallest payload that exposed the bug.
    const { status } = await send(`/api/analysis/${analysisId}/pose`, 'PUT', posePayload(30))
    expect(status).toBe(204)
  })

  it('stores a full set at 60 fps', async () => {
    // 900 frames — a 15-second lift off a phone. ~3 MB.
    const { status } = await send(`/api/analysis/${analysisId}/pose`, 'PUT', posePayload(900))
    expect(status).toBe(204)
  })

  it('reads back what it stored, at full length', async () => {
    const frames = 900
    await send(`/api/analysis/${analysisId}/pose`, 'PUT', posePayload(frames))
    const res = await fetch(`${baseUrl}/api/analysis/${analysisId}/pose`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.frameCount).toBe(frames)
    expect(body.keypoints).toHaveLength(frames * LANDMARK_COUNT * FLOATS_PER_LANDMARK)
    // The world set is what joint angles are measured from; losing it in
    // transit would silently downgrade every angle to the image-space basis.
    expect(body.world).toHaveLength(frames * LANDMARK_COUNT * FLOATS_PER_LANDMARK)
  })

  it('refuses a track past the frame cap through the schema, not the parser', async () => {
    const { status, body } = await send(`/api/analysis/${analysisId}/pose`, 'PUT', {
      ...posePayload(2),
      frameCount: 36_001,
    })
    // A 400 from Zod, never a 413 from the body parser: the two limits are one
    // decision, and the schema is the one that should be doing the refusing.
    expect(status).toBe(400)
    expect(body.error).toBe('Invalid pose track')
  })
})

describe('bar path body size', () => {
  it('saves a path longer than the old 100 kb default allowed', async () => {
    // ~1,800 samples was the old ceiling: about 55 seconds at 30 fps, which is
    // an ordinary form check. 5,000 is comfortably past it.
    const { status, body } = await send('/api/analysis', 'POST', {
      mediaId: null,
      athleteId: null,
      sourceLabel: 'long clip',
      track: track(5_000),
      calibration: null,
      metrics: [],
      notes: null,
    })
    expect(status).toBe(201)
    expect(body.id).toBeTruthy()
  })

  it('still refuses a path past the frame cap', async () => {
    const { status } = await send('/api/analysis', 'POST', {
      mediaId: null,
      athleteId: null,
      sourceLabel: 'too long',
      track: track(36_001),
      calibration: null,
      metrics: [],
      notes: null,
    })
    expect(status).toBe(400)
  })
}, 60_000)

describe('the limit stays scoped to /api/analysis', () => {
  it('does not raise the body limit for other routers', async () => {
    // The fix mounts a generous parser on one router rather than raising the
    // global default. If someone later moves that mount, or swaps it for a
    // global limit, this is what notices.
    const padded = { name: 'x'.repeat(200_000) }
    const res = await fetch(`${baseUrl}/api/athletes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(padded),
    })
    expect(res.status).toBe(413)
  })
})
