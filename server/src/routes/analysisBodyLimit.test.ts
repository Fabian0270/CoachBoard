import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { LANDMARK_COUNT, FLOATS_PER_LANDMARK, POSE_WIRE_TYPE, decodePoseTrack, encodePoseTrack } from 'coachboard-shared/pose'
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

/** A pose track of `frames` frames, packed exactly as poseApi.savePose sends it. */
const posePayload = (frames: number): Uint8Array => {
  const floats = frames * LANDMARK_COUNT * FLOATS_PER_LANDMARK
  return encodePoseTrack({
    frameCount: frames,
    landmarkCount: LANDMARK_COUNT,
    keypoints: Float32Array.from({ length: floats }, (_, i) => (i % 1080) + 0.123456789),
    world: Float32Array.from({ length: floats }, (_, i) => (i % 100) / 100 - 0.5),
    times: Float64Array.from({ length: frames }, (_, i) => i / 30),
  })
}

const putPose = async (body: Uint8Array) => {
  const res = await fetch(`${baseUrl}/api/analysis/${analysisId}/pose`, {
    method: 'PUT',
    headers: { 'Content-Type': POSE_WIRE_TYPE },
    body: body.buffer as ArrayBuffer,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
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
    const { status } = await putPose(posePayload(30))
    expect(status).toBe(204)
  })

  it('stores a full set at 60 fps', async () => {
    // 900 frames — a 15-second lift off a phone.
    const { status } = await putPose(posePayload(900))
    expect(status).toBe(204)
  })

  it('stores a track at the frame cap — ten minutes of 60 fps', async () => {
    // ~29 MB packed. As JSON this was ~130 MB and took over a second to parse
    // on the process that runs the whole app.
    const { status } = await putPose(posePayload(36_000))
    expect(status).toBe(204)
  }, 60_000)

  it('reads back what it stored, at full length and exactly', async () => {
    const frames = 900
    const sent = posePayload(frames)
    await putPose(sent)
    const res = await fetch(`${baseUrl}/api/analysis/${analysisId}/pose`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain(POSE_WIRE_TYPE)
    const { packed, meta } = decodePoseTrack(new Uint8Array(await res.arrayBuffer()), { maxFrames: 36_000, maxLandmarks: 64 })
    const original = decodePoseTrack(sent, { maxFrames: 36_000, maxLandmarks: 64 }).packed
    expect(packed.frameCount).toBe(frames)
    expect(packed.keypoints).toEqual(original.keypoints)
    // The world set is what joint angles are measured from; losing it in
    // transit would silently downgrade every angle to the image-space basis.
    expect(packed.world).toEqual(original.world)
    expect(packed.times).toEqual(original.times)
    expect(meta).toMatchObject({ corrections: [] })
  })

  it('refuses a track past the frame cap with a 400, not a 413', async () => {
    const body = posePayload(2)
    new DataView(body.buffer).setUint32(4, 36_001, true) // frameCount in the header
    const { status, body: answer } = await putPose(body)
    expect(status).toBe(400)
    expect(answer.error).toBe('Invalid pose track')
  })

  it('refuses a truncated track', async () => {
    const { status } = await putPose(posePayload(30).slice(0, 1000))
    expect(status).toBe(400)
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
