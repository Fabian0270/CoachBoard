import { describe, it, expect } from 'vitest'
import {
  verticalVelocity,
  segmentReps,
  repMetrics,
  analysePath,
  looksMistracked,
  pixelsPerMetreFromPlate,
  type Sample,
} from 'coachboard-shared/videoAnalysis'

// These are the numbers a coach will read off the screen and act on, so they are
// checked against synthetic paths whose true answer is known exactly rather than
// against whatever the code happens to produce.

/** Constant-velocity fall: y grows downward, so this is the bar descending. */
function linearPath(from: number, pxPerSecond: number, count: number, fps = 30): Sample[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i / fps,
    x: 100,
    y: from + (pxPerSecond * i) / fps,
  }))
}

/**
 * A squat-shaped path: `reps` cycles of descend-then-rise between two heights,
 * starting at the top. Triangular rather than sinusoidal so the true mean
 * concentric speed is exactly `pxPerSecond` and can be asserted directly.
 */
function repPath(reps: number, topY: number, bottomY: number, pxPerSecond: number, fps = 30): Sample[] {
  const samples: Sample[] = []
  const travel = bottomY - topY
  const framesPerHalf = Math.round((travel / pxPerSecond) * fps)
  let t = 0
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < framesPerHalf; i++) {
      samples.push({ t, x: 100, y: topY + (travel * i) / framesPerHalf })
      t += 1 / fps
    }
    for (let i = 0; i < framesPerHalf; i++) {
      samples.push({ t, x: 100, y: bottomY - (travel * i) / framesPerHalf })
      t += 1 / fps
    }
  }
  samples.push({ t, x: 100, y: topY })
  return samples
}

describe('verticalVelocity', () => {
  it('recovers a known constant velocity', () => {
    const samples = linearPath(100, 60, 30) // 60 px/s downward
    const v = verticalVelocity(samples)
    // Interior points, away from the window-edge fallback.
    for (const s of v.slice(6, -6)) expect(s.vy).toBeCloseTo(60, 1)
  })

  it('signs upward motion negative, matching image coordinates', () => {
    const v = verticalVelocity(linearPath(400, -80, 30))
    for (const s of v.slice(6, -6)) expect(s.vy).toBeCloseTo(-80, 1)
  })

  it('is unaffected by irregular frame timing', () => {
    // Same 60 px/s motion, but with variable-frame-rate style jitter in `t`.
    // A fixed-kernel filter would skew here; regressing on real timestamps
    // should not.
    const samples: Sample[] = []
    let t = 0
    for (let i = 0; i < 40; i++) {
      t += i % 3 === 0 ? 0.05 : 0.025
      samples.push({ t, x: 100, y: 100 + 60 * t })
    }
    for (const s of verticalVelocity(samples).slice(6, -6)) expect(s.vy).toBeCloseTo(60, 0)
  })

  it('degrades safely on inputs too short to fit a curve', () => {
    expect(verticalVelocity([]).length).toBe(0)
    expect(verticalVelocity([{ t: 0, x: 1, y: 1 }])).toEqual([{ t: 0, vy: 0 }])
  })
})

describe('segmentReps', () => {
  it('finds every rep in a clean multi-rep set', () => {
    const samples = repPath(3, 100, 340, 240)
    const reps = segmentReps(samples, verticalVelocity(samples))
    expect(reps).toHaveLength(3)
  })

  it('finds the rep in a clip that already starts at the bottom', () => {
    // Coaches trim to the lift, so the clip often opens mid-rep with the bar
    // already down. Without special handling this rep is invisible.
    const full = repPath(1, 100, 340, 240)
    const fromBottom = full.slice(Math.floor(full.length / 2) - 2)
    const reps = segmentReps(fromBottom, verticalVelocity(fromBottom))
    expect(reps).toHaveLength(1)
  })

  it('ignores jitter that never travels far enough to be a rep', () => {
    const samples: Sample[] = Array.from({ length: 90 }, (_, i) => ({
      t: i / 30,
      x: 100,
      y: 200 + Math.sin(i / 2) * 3, // a few pixels of tracker wobble
    }))
    expect(segmentReps(samples, verticalVelocity(samples))).toHaveLength(0)
  })

  it('returns nothing rather than guessing on a too-short path', () => {
    const samples = linearPath(100, 60, 2)
    expect(segmentReps(samples, verticalVelocity(samples))).toHaveLength(0)
  })

  it('drops a twitch that clears the pixel floor but is nothing like a rep', () => {
    // A real 5-rep squat came back as six. The phantom travelled 3 cm against a
    // 100 cm median — plainly not a rep at any zoom, but on close footage that
    // is well over the 20 px floor, which is why the floor cannot be absolute.
    const big = repPath(2, 100, 900, 800) // ~800 px of travel per rep
    const t0 = big[big.length - 1].t
    const twitch: Sample[] = Array.from({ length: 26 }, (_, i) => ({
      t: t0 + (i + 1) / 30,
      x: 100,
      y: 100 + (i < 13 ? i * 2 : (26 - i) * 2), // 26 px down and back up
    }))
    const rest = repPath(2, 100, 900, 800).map((s) => ({
      ...s,
      t: s.t + twitch[twitch.length - 1].t + 1 / 30,
    }))
    const samples = [...big, ...twitch, ...rest]

    const reps = segmentReps(samples, verticalVelocity(samples))
    expect(reps).toHaveLength(4)
    // Indexes are renumbered after the drop, so nothing downstream sees a gap.
    expect(reps.map((r) => r.index)).toEqual([0, 1, 2, 3])
  })

  it('does not let one bad sample become the peak, and flags what it cannot fix', () => {
    // A real 165 kg bench reported a 1.69 m/s peak against a 0.14 mean: over the
    // smoothing window that is the tracked point jumping 25 cm, which is a
    // re-lock, not a barbell.
    const clean = repPath(1, 100, 340, 240)
    const glitched = clean.map((s, i) => (i === 12 ? { ...s, y: s.y - 120 } : s))
    const vel = verticalVelocity(glitched)
    const rep = repMetrics(segmentReps(glitched, vel)[0], glitched, vel, null)

    // The percentile steps over the very worst samples rather than reporting one.
    const rawMax = Math.max(...vel.map((v) => Math.abs(v.vy)))
    expect(rep.peakVelocityPxS).toBeLessThan(rawMax)

    // Whether what is left still reads as mistracked depends on how slow the rep
    // was, so that threshold is asserted against the real observed shape in the
    // looksMistracked block rather than against a synthetic tuned to trip it.

    // The mean is barely touched, which is exactly why it is the safe default.
    const cleanVel = verticalVelocity(clean)
    const cleanMean = repMetrics(segmentReps(clean, cleanVel)[0], clean, cleanVel, null)
      .meanVelocityPxS
    expect(rep.meanVelocityPxS).toBeGreaterThan(cleanMean * 0.7)
  })

  it('keeps a genuinely short set rather than measuring it against a fixed size', () => {
    // Every rep short is a rep range, not noise: the median moves with them.
    const samples = repPath(3, 100, 160, 60)
    expect(segmentReps(samples, verticalVelocity(samples))).toHaveLength(3)
  })
})

describe('repMetrics', () => {
  it('reports the true concentric speed and range', () => {
    const samples = repPath(1, 100, 340, 240) // 240 px/s, 240 px of travel
    const velocities = verticalVelocity(samples)
    const [rep] = segmentReps(samples, velocities)
    const m = repMetrics(rep, samples, velocities, null)

    expect(m.romPx).toBeGreaterThan(220)
    expect(m.meanVelocityPxS).toBeGreaterThan(200)
    expect(m.meanVelocityPxS).toBeLessThan(260)
    expect(m.peakVelocityPxS).toBeGreaterThanOrEqual(m.meanVelocityPxS)
    expect(m.durationMs).toBeGreaterThan(800)
  })

  it('ignores dead time at the bottom instead of averaging it in', () => {
    // A deadlift sits on the floor while tension is built. Counting that as
    // part of the lift dragged a real clip to 0.16 m/s mean against a 0.74 m/s
    // peak — the headline number was mostly measuring the setup.
    const rising = repPath(1, 100, 340, 240)
    const bottomHalf = rising.slice(Math.floor(rising.length / 2) - 2)
    const pause: Sample[] = Array.from({ length: 60 }, (_, i) => ({
      t: i / 30,
      x: 100,
      y: bottomHalf[0].y,
    }))
    const withPause: Sample[] = [
      ...pause,
      ...bottomHalf.map((s) => ({ ...s, t: s.t + 2 })),
    ]

    const velocities = verticalVelocity(withPause)
    const [rep] = segmentReps(withPause, velocities)
    const m = repMetrics(rep, withPause, velocities, null)

    // Without trimming this would sit far below the true 240 px/s.
    expect(m.meanVelocityPxS).toBeGreaterThan(150)
    // And the full travel is still reported, since the trim removes only time.
    expect(m.romPx).toBeGreaterThan(220)
  })

  it('leaves metric units null until calibrated, so nothing invents an m/s', () => {
    const samples = repPath(1, 100, 340, 240)
    const velocities = verticalVelocity(samples)
    const [rep] = segmentReps(samples, velocities)
    const m = repMetrics(rep, samples, velocities, null)

    expect(m.romM).toBeNull()
    expect(m.meanVelocity).toBeNull()
    expect(m.peakVelocity).toBeNull()
  })

  it('converts to m/s once a scale is known', () => {
    const samples = repPath(1, 100, 340, 240)
    const velocities = verticalVelocity(samples)
    const [rep] = segmentReps(samples, velocities)
    // 480 px per metre => 240 px/s is 0.5 m/s, 240 px of travel is 0.5 m.
    const m = repMetrics(rep, samples, velocities, 480)

    expect(m.romM).toBeCloseTo(0.5, 1)
    expect(m.meanVelocity).toBeCloseTo(0.5, 1)
  })
})

describe('pixelsPerMetreFromPlate', () => {
  it('scales from a competition plate', () => {
    // A 450 mm plate spanning 225 px means 500 px per metre.
    expect(pixelsPerMetreFromPlate(225, 450)).toBeCloseTo(500, 5)
  })

  it('refuses nonsense rather than returning Infinity', () => {
    expect(pixelsPerMetreFromPlate(0, 450)).toBeNull()
    expect(pixelsPerMetreFromPlate(200, 0)).toBeNull()
  })
})

describe('analysePath', () => {
  it('produces one metrics row per rep', () => {
    const samples = repPath(3, 100, 340, 240)
    const { reps, velocities } = analysePath(samples, 480)

    expect(velocities).toHaveLength(samples.length)
    expect(reps).toHaveLength(3)
    expect(reps.map((r) => r.index)).toEqual([0, 1, 2])
    // Identical synthetic reps should measure alike.
    const speeds = reps.map((r) => r.meanVelocity ?? 0)
    for (const s of speeds) expect(s).toBeCloseTo(speeds[0], 1)
  })
})

describe('looksMistracked', () => {
  const rep = (mean: number, peak: number) =>
    ({
      index: 0, startT: 0, endT: 1, durationMs: 1000, romPx: 200,
      meanVelocityPxS: mean * 100, peakVelocityPxS: peak * 100,
      romM: null, meanVelocity: mean, peakVelocity: peak,
      meanPropulsiveVelocity: mean, propulsiveFraction: 1,
    }) as const

  it('flags the bench rep whose peak was twelve times its mean', () => {
    expect(looksMistracked(rep(0.14, 1.69))).toBe(true)
  })

  it('leaves real reps alone across all three lifts', () => {
    expect(looksMistracked(rep(0.24, 0.37))).toBe(false) // bench single
    expect(looksMistracked(rep(0.62, 1.06))).toBe(false) // squat first rep
    expect(looksMistracked(rep(0.39, 0.87))).toBe(false) // squat fifth rep
  })

  it('says nothing about a rep with no movement to judge', () => {
    expect(looksMistracked(rep(0, 0))).toBe(false)
  })
})
