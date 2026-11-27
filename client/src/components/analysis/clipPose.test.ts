import { describe, it, expect, vi } from 'vitest'
import { readFrames, type DecodedFrame } from './clipPose'
import type { PoseStream } from './usePose'
import type { PoseFrame } from 'coachboard-shared/pose'

// D117: the whole clip is read before the skeleton is shown.

/** A canvas stand-in: getImageData is all the reader asks of it. */
const canvas = () => ({ width: 4, height: 2, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(32) }) }) }) as unknown as HTMLCanvasElement

async function* clip(seconds: number, fps: number): AsyncGenerator<DecodedFrame> {
  for (let i = 0; i < seconds * fps; i++) yield { t: i / fps, canvas: canvas() }
}

function fakeStream() {
  const pushed: number[] = []
  const frames: PoseFrame[] = []
  const stream: PoseStream = {
    push: vi.fn(async (f) => { pushed.push(f.t); frames.push({ t: f.t, landmarks: [] }) }),
    get frames() { return frames },
    close: vi.fn(),
  }
  return { stream, pushed }
}

describe('readFrames', () => {
  it('reads 15 frames a second: every other frame of 30 fps footage', async () => {
    const { stream, pushed } = fakeStream()
    const out = await readFrames(clip(2, 30), { stream, duration: 2 })
    expect(pushed).toHaveLength(30)
    expect(pushed.slice(0, 3)).toEqual([0, 2 / 30, 4 / 30])
    expect(out).toHaveLength(30)
  })

  it('reads every frame of footage at 15 fps or less', async () => {
    const { stream, pushed } = fakeStream()
    await readFrames(clip(2, 12), { stream, duration: 2 })
    expect(pushed).toHaveLength(24)
  })

  it('reports how far through the clip it is', async () => {
    const { stream } = fakeStream()
    const progress: number[] = []
    await readFrames(clip(2, 30), { stream, duration: 2, onProgress: (f) => progress.push(f) })
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBeCloseTo(58 / 60, 5)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)
  })

  it('stops when aborted, keeping what it read', async () => {
    const { stream, pushed } = fakeStream()
    const controller = new AbortController()
    const out = await readFrames(clip(2, 30), {
      stream, duration: 2, signal: controller.signal,
      onProgress: (f) => { if (f >= 0.5) controller.abort() },
    })
    expect(pushed.length).toBeLessThan(30)
    expect(out.length).toBe(pushed.length)
  })

  it('waits while held (tracking needs the CPU), then carries on', async () => {
    vi.useFakeTimers()
    try {
      const { stream, pushed } = fakeStream()
      let held = true
      const done = readFrames(clip(1, 15), { stream, duration: 1, hold: () => held })
      await vi.advanceTimersByTimeAsync(1000)
      expect(pushed).toHaveLength(0)
      held = false
      await vi.advanceTimersByTimeAsync(1000)
      await done
      expect(pushed).toHaveLength(15)
    } finally {
      vi.useRealTimers()
    }
  })
})
