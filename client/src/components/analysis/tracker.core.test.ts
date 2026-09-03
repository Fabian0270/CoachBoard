import { describe, it, expect, beforeAll } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import { trackFrames, type Frame, type OpenCv, type Seed } from './tracker.core'

// The tracker is the highest-risk module in Feature 11b, and it normally only
// runs inside a Web Worker behind a 10 MB Emscripten bundle. Injecting opencv
// makes it testable here: opencv.js loads fine under plain Node (see the
// package.json shim beside the vendored file), so the algorithm can be measured
// against footage whose true answer is known exactly.

let cv: OpenCv

beforeAll(async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const opencvPath = path.resolve(here, '../../../public/vendor/opencv/opencv.js')
  cv = createRequire(import.meta.url)(opencvPath)
  if (!cv.getBuildInformation) {
    await new Promise<void>((resolve) => {
      cv.onRuntimeInitialized = () => resolve()
    })
  }
}, 60_000)

const W = 240
const H = 320
const RADIUS = 22

// Smooth value noise: irregular like a real plate's markings and scuffs, and
// crucially NON-periodic. A repeating pattern (a sine grid, say) is pathological
// for optical flow — points lock onto the wrong period and the track picks up a
// systematic offset that has nothing to do with the algorithm being tested.
function hash2(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  // Smoothstep so the field is continuous in value AND gradient, which is what
  // lets LK resolve motion below one pixel.
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const lerp = (a: number, b: number, w: number) => a + (b - a) * w
  return lerp(
    lerp(hash2(xi, yi), hash2(xi + 1, yi), u),
    lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u),
    v,
  )
}

/**
 * One frame: a textured disc (a plate) on a textured background.
 *
 * Both need texture. A flat disc gives goodFeaturesToTrack nothing to find, and
 * a flat background makes the test easier than reality — the interesting failure
 * is a point letting go of the plate and latching onto what's behind it.
 */
function renderFrame(t: number, cx: number, cy: number): Frame {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const dx = x - cx
      const dy = y - cy
      // Two properties this fixture has to get right, or it tests the fixture
      // rather than the tracker:
      //  1. The plate's markings are keyed to the disc's OWN coordinates, so
      //     they travel with it the way real lettering does. Keyed to absolute
      //     image position, the texture stands still while the outline moves and
      //     optical flow gets contradictory evidence.
      //  2. Everything is continuous — smooth texture, anti-aliased rim. Real
      //     video carries sub-pixel gradients; a hard-edged, integer-quantised
      //     disc can only move in whole pixels, so it understates the accuracy
      //     LK actually achieves.
      const plate = 140 + 100 * valueNoise(dx * 0.45 + 50, dy * 0.45 + 50)
      const gym = 30 + 40 * valueNoise(x * 0.3, y * 0.3) // the room behind it, which stays put
      const rim = Math.min(1, Math.max(0, (RADIUS - Math.hypot(dx, dy)) / 1.5))
      const v = gym + (plate - gym) * rim
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { t, width: W, height: H, data }
}

/** Frames following a path, plus the seed box around the disc's start. */
function sequence(pathFn: (i: number) => { x: number; y: number }, count: number, fps = 30) {
  const truth = Array.from({ length: count }, (_, i) => pathFn(i))
  const frames = truth.map((p, i) => renderFrame(i / fps, p.x, p.y))
  const seed: Seed = {
    x: truth[0].x - RADIUS,
    y: truth[0].y - RADIUS,
    width: RADIUS * 2,
    height: RADIUS * 2,
  }
  return { frames, seed, truth }
}

function maxError(samples: { x: number; y: number }[], truth: { x: number; y: number }[]): number {
  let worst = 0
  for (let i = 0; i < Math.min(samples.length, truth.length); i++) {
    worst = Math.max(worst, Math.hypot(samples[i].x - truth[i].x, samples[i].y - truth[i].y))
  }
  return worst
}

describe('trackFrames', () => {
  it('follows a straight vertical lift to within a pixel', () => {
    // The bar path that matters: mostly vertical, ~2.5 px/frame.
    const { frames, seed, truth } = sequence((i) => ({ x: 120, y: 240 - i * 2.5 }), 40)
    const { samples, quality } = trackFrames(cv, frames, seed)

    expect(samples).toHaveLength(frames.length)
    expect(quality.lostAtFrame).toBeNull()
    expect(quality.seededPoints).toBeGreaterThan(10)
    // Measured at 0.71 px over 100 px of travel when this was written. The
    // bound is loose enough to absorb opencv build differences, tight enough
    // that a real regression (accumulating drift) trips it immediately.
    expect(maxError(samples, truth)).toBeLessThan(1.5)
  })

  it('follows a lift that drifts horizontally, as a real bar does', () => {
    const { frames, seed, truth } = sequence(
      (i) => ({ x: 110 + Math.sin(i / 6) * 12, y: 250 - i * 2.2 }),
      45,
    )
    const { samples, quality } = trackFrames(cv, frames, seed)

    expect(quality.lostAtFrame).toBeNull()
    expect(maxError(samples, truth)).toBeLessThan(2.5)
  })

  it('carries irregular frame timings through untouched', () => {
    // Variable-frame-rate phone video: the timestamps are the input, and
    // deriving an fps from a frame count would silently skew every velocity.
    const { frames, seed } = sequence((i) => ({ x: 120, y: 240 - i * 2 }), 12)
    frames.forEach((f, i) => {
      f.t = i * 0.033 + (i % 3 === 0 ? 0.012 : 0)
    })
    const { samples, quality } = trackFrames(cv, frames, seed)

    expect(samples.map((s) => s.t)).toEqual(frames.map((f) => f.t))
    expect(quality.effectiveFps).toBeGreaterThan(20)
    expect(quality.effectiveFps).toBeLessThan(35)
  })

  it('reports survival and reseeds so the UI can refuse to show bad numbers', () => {
    const { frames, seed } = sequence((i) => ({ x: 120, y: 240 - i * 2.5 }), 25)
    const { quality } = trackFrames(cv, frames, seed)

    // Clean synthetic footage should need no rescuing at all.
    expect(quality.medianSurvivalRate).toBeGreaterThan(0.8)
    expect(quality.reseeds).toBe(0)
  })

  it('gives up rather than inventing a path when the target vanishes', () => {
    const { frames, seed } = sequence((i) => ({ x: 120, y: 240 - i * 2.5 }), 20)
    // Wipe the plate to flat grey from frame 8 on: nothing left to track.
    for (let i = 8; i < frames.length; i++) {
      frames[i].data.fill(128)
      for (let p = 3; p < frames[i].data.length; p += 4) frames[i].data[p] = 255
    }
    const { samples, quality } = trackFrames(cv, frames, seed)

    expect(quality.lostAtFrame).not.toBeNull()
    expect(samples.length).toBeLessThan(frames.length)
  })

  it('degrades safely on a single frame instead of throwing', () => {
    const { frames, seed } = sequence((i) => ({ x: 120, y: 240 - i * 2 }), 1)
    const { samples } = trackFrames(cv, frames, seed)
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ x: 120, y: 240 })
  })
})
