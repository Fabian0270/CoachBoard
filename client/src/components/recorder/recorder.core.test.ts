import { describe, it, expect } from 'vitest'
import {
  DISCORD_MAX_BYTES,
  EMAIL_MAX_BYTES,
  blockedReason,
  budgetMs,
  deliveryFitness,
  estimateBytes,
  formatBytes,
  formatDuration,
  isCapturing,
  nextState,
  planEncoding,
  sizeStatus,
  type RecorderState,
} from './recorder.core'

// These numbers decide whether a coach's recording can be delivered at all, and
// the browser half of the recorder cannot be tested in this repo (no jsdom, no
// testing-library). So the arithmetic and the state machine are tested here and
// the DOM plumbing is verified by hand — same division as tracker.core.

describe('planEncoding', () => {
  it('caps the long edge at 1280 and keeps the aspect ratio', () => {
    const plan = planEncoding(3840, 2160)
    expect(plan.width).toBe(1280)
    expect(plan.height).toBe(720)
  })

  it('caps the long edge on portrait sources too', () => {
    const plan = planEncoding(1080, 1920)
    expect(plan.height).toBe(1280)
    expect(plan.width).toBe(720)
  })

  it('never upscales a small window', () => {
    const plan = planEncoding(640, 480)
    expect(plan.width).toBe(640)
    expect(plan.height).toBe(480)
  })

  it('always produces even dimensions, which encoders require', () => {
    // 1365x767 scales to a fractional size in both axes.
    const plan = planEncoding(1365, 767)
    expect(plan.width % 2).toBe(0)
    expect(plan.height % 2).toBe(0)
  })

  it('scales bitrate with pixel count, within the clamp', () => {
    const small = planEncoding(640, 360)
    const large = planEncoding(1920, 1080)
    expect(small.videoBitsPerSecond).toBeLessThan(large.videoBitsPerSecond)
    expect(small.videoBitsPerSecond).toBeGreaterThanOrEqual(600_000)
    expect(large.videoBitsPerSecond).toBeLessThanOrEqual(2_500_000)
  })

  it('still returns a usable plan before the source reports dimensions', () => {
    const plan = planEncoding(0, 0)
    expect(plan.width).toBeGreaterThan(0)
    expect(plan.height).toBeGreaterThan(0)
    expect(plan.videoBitsPerSecond).toBeGreaterThan(0)
  })
})

describe('size estimation', () => {
  it('estimateBytes and budgetMs are inverses', () => {
    const plan = planEncoding(1280, 720)
    const ms = budgetMs(DISCORD_MAX_BYTES, plan)
    // Round-trips to the cap, give or take integer rounding.
    expect(estimateBytes(ms, plan)).toBeGreaterThan(DISCORD_MAX_BYTES * 0.999)
    expect(estimateBytes(ms, plan)).toBeLessThanOrEqual(DISCORD_MAX_BYTES * 1.001)
  })

  it('confirms the headline constraint: 720p fits Discord for well under two minutes', () => {
    // This is the number the plan is built around — if it ever changes, the
    // whole "Discord is for short form checks" framing has to change with it.
    const seconds = budgetMs(DISCORD_MAX_BYTES, planEncoding(1280, 720)) / 1000
    expect(seconds).toBeGreaterThan(45)
    expect(seconds).toBeLessThan(120)
  })

  it('treats a zero-length recording as zero bytes', () => {
    expect(estimateBytes(0, planEncoding(1280, 720))).toBe(0)
  })
})

describe('deliveryFitness', () => {
  it('lets disk take anything, however large', () => {
    expect(deliveryFitness(5 * 1024 * 1024 * 1024).disk).toBe(true)
  })

  it('rules out Discord but not email in the gap between the two caps', () => {
    const between = (DISCORD_MAX_BYTES + EMAIL_MAX_BYTES) / 2
    expect(deliveryFitness(between)).toEqual({ discord: false, email: true, disk: true })
  })

  it('accepts a file exactly on the cap', () => {
    expect(deliveryFitness(DISCORD_MAX_BYTES).discord).toBe(true)
    expect(deliveryFitness(DISCORD_MAX_BYTES + 1).discord).toBe(false)
  })
})

describe('sizeStatus', () => {
  it('warns before the cap rather than at it', () => {
    expect(sizeStatus(1024)).toBe('ok')
    expect(sizeStatus(DISCORD_MAX_BYTES * 0.85)).toBe('near')
    expect(sizeStatus(DISCORD_MAX_BYTES + 1)).toBe('over')
  })
})

describe('blockedReason', () => {
  it('says nothing when the channel can take the file', () => {
    expect(blockedReason('discord', 1024)).toBeNull()
    expect(blockedReason('disk', Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it('names an alternative rather than just refusing', () => {
    const reason = blockedReason('discord', DISCORD_MAX_BYTES * 3)
    expect(reason).toContain('email')
    expect(reason).toContain('save it to your PC')
  })
})

describe('formatting', () => {
  it('formats bytes at a readable precision', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB')
  })

  it('formats durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9_000)).toBe('0:09')
    expect(formatDuration(125_000)).toBe('2:05')
  })
})

describe('state machine', () => {
  it('runs the ordinary path from idle to review', () => {
    const path: Array<[RecorderState, Parameters<typeof nextState>[1], RecorderState]> = [
      ['idle', 'open', 'preflight'],
      ['preflight', 'start', 'countdown'],
      ['countdown', 'countdownDone', 'recording'],
      ['recording', 'stop', 'finalizing'],
      ['finalizing', 'finalized', 'review'],
      ['review', 'discard', 'idle'],
    ]
    for (const [from, event, to] of path) expect(nextState(from, event)).toBe(to)
  })

  it('pauses and resumes without leaving the capturing states', () => {
    expect(nextState('recording', 'pause')).toBe('paused')
    expect(nextState('paused', 'resume')).toBe('recording')
    expect(isCapturing('recording')).toBe(true)
    expect(isCapturing('paused')).toBe(true)
    expect(isCapturing('finalizing')).toBe(false)
  })

  it('ignores events that do not apply instead of throwing', () => {
    // A stop arriving after finalize already started, which a stray
    // MediaRecorder event can genuinely cause.
    expect(nextState('finalizing', 'stop')).toBeNull()
    expect(nextState('idle', 'stop')).toBeNull()
    expect(nextState('review', 'pause')).toBeNull()
  })

  it('keeps a failed recording rather than discarding the coach s voice-over', () => {
    // Chunks are already on disk by then; dropping them would be the worst
    // possible response to a stream dying at the end.
    expect(nextState('recording', 'failed')).toBe('finalizing')
    expect(nextState('paused', 'failed')).toBe('finalizing')
  })

  it('abandons a failure that happens before anything was captured', () => {
    expect(nextState('preflight', 'failed')).toBe('idle')
    expect(nextState('countdown', 'failed')).toBe('idle')
  })

  it('can start a second recording straight from review', () => {
    expect(nextState('review', 'open')).toBe('preflight')
  })
})
