import { describe, it, expect } from 'vitest'
import { analysePath, verticalVelocity, type Sample } from 'coachboard-shared/videoAnalysis'
import { anglesAgainstBar, stickingPoint, type FrameAngles } from 'coachboard-shared/pose'
import { buildLoadVelocityProfile, resolveLvSlope, e1RMFromVelocity } from 'coachboard-shared/vbt'

// Each case reproduces a measurement from the 2026-11 audit, where the number
// the coach saw was wrong. Paths are synthetic so the true answer is known.

/** One rep around `yTop`: down `rom` px and back up, as a smooth cosine. */
function rep(out: Sample[], t0: number, dur: number, rom: number, fps: number, yTop: number): number {
  const n = Math.round(dur * fps)
  for (let i = 0; i < n; i++) {
    const u = i / n
    out.push({ t: t0 + u * dur, x: 500, y: yTop + (rom / 2) * (1 - Math.cos(2 * Math.PI * u)) })
  }
  return t0 + dur
}
function hold(out: Sample[], t0: number, dur: number, fps: number, y: number): number {
  const n = Math.round(dur * fps)
  for (let i = 0; i < n; i++) out.push({ t: t0 + i / fps, x: 500, y })
  return t0 + dur
}

/** About 1,100 px/m: a 450 mm plate roughly 500 px across. */
const PPM = 1100

describe('rep segmentation', () => {
  it('ignores walkout sways around a single rep', () => {
    // One 55 cm squat with a 2.5 cm sway either side. The median of the three
    // cycles is a sway, so they used to survive — and the last one, at
    // 0.06 m/s, was the "last rep" every RPE reading is taken from.
    const s: Sample[] = []
    let t = hold(s, 0, 0.6, 25, 800)
    t = rep(s, t, 0.8, 28, 25, 800)
    t = hold(s, t, 0.4, 25, 800)
    t = rep(s, t, 3.0, 605, 25, 800)
    t = hold(s, t, 0.4, 25, 800)
    t = rep(s, t, 0.8, 28, 25, 800)
    hold(s, t, 0.4, 25, 800)

    const reps = analysePath(s, PPM).reps
    expect(reps).toHaveLength(1)
    expect(reps[0].romM!).toBeCloseTo(0.55, 2)
  })

  it('drops the sways even without a scale, relative to the largest rep', () => {
    const s: Sample[] = []
    let t = rep(s, 0, 0.8, 28, 25, 800)
    t = rep(s, t, 3.0, 605, 25, 800)
    rep(s, t, 0.8, 28, 25, 800)
    expect(analysePath(s, null).reps).toHaveLength(1)
  })

  it('still keeps a failed rep that got halfway', () => {
    const s: Sample[] = []
    let t = rep(s, 0, 3.0, 600, 25, 800)
    t = rep(s, t, 3.0, 600, 25, 800)
    rep(s, t, 3.0, 300, 25, 800)
    expect(analysePath(s, PPM).reps).toHaveLength(3)
  })
})

describe('mean velocity', () => {
  it('does not depend on where frames happened to be dropped', () => {
    // Drops clustered in the fast middle of the ascent used to read 0.322 m/s
    // against a true 0.383: averaging samples weights each moment by how many
    // frames landed in it.
    const full: Sample[] = []
    let t = hold(full, 0, 0.3, 30, 800)
    t = rep(full, t, 3.0, 605, 30, 800)
    hold(full, t, 0.3, 30, 800)
    const thinned = full.filter((p, i) => !(p.t > 2.3 && p.t < 2.8 && i % 3 !== 0))

    const a = analysePath(full, PPM).reps[0]
    const b = analysePath(thinned, PPM).reps[0]
    // Mean concentric velocity is distance over time.
    expect(a.meanVelocity!).toBeCloseTo(a.romM! / (a.durationMs / 1000), 1)
    expect(Math.abs(a.meanVelocity! - b.meanVelocity!)).toBeLessThan(0.02)
  })
})

describe('speed', () => {
  it('analyses a track at the frame cap quickly enough for the UI thread', () => {
    // 36,000 samples took 8.5 s, re-run on every calibration click.
    const s: Sample[] = []
    for (let i = 0; i < 36_000; i++) s.push({ t: i / 30, x: 500, y: 800 + 300 * Math.sin(i / 45) })
    const started = performance.now()
    analysePath(s, PPM)
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('sticking point', () => {
  it('lands on the slow-down in the middle of the ascent, not on standing still', () => {
    // A squat whose ascent slows sharply halfway up. Marked 0.37 s before —
    // while the lifter was still standing at the top.
    const fps = 30
    const s: Sample[] = []
    const yTop = 400
    const yBot = 1000
    for (let i = 0; i < 0.5 * fps; i++) s.push({ t: i / fps, x: 0, y: yTop })
    for (let i = 0; i < 1.5 * fps; i++) {
      const u = i / (1.5 * fps)
      s.push({ t: 0.5 + u * 1.5, x: 0, y: yTop + (yBot - yTop) * (0.5 - 0.5 * Math.cos(Math.PI * u)) })
    }
    // Ascent speed ∝ sin(πu) with a deep dip at u = 0.5, integrated numerically.
    const speed = (w: number) => Math.sin(Math.PI * w) * (1 - 0.8 * Math.exp(-(((w - 0.5) / 0.12) ** 2)))
    const N = 400
    let total = 0
    for (let k = 0; k < N; k++) total += speed(k / N)
    for (let i = 0; i < 2.5 * fps; i++) {
      const u = i / (2.5 * fps)
      let acc = 0
      for (let k = 0; k < N && k / N <= u; k++) acc += speed(k / N)
      s.push({ t: 2.0 + u * 2.5, x: 0, y: yBot - (yBot - yTop) * (acc / total) })
    }
    for (let i = 0; i < 0.5 * fps; i++) s.push({ t: 4.5 + i / fps, x: 0, y: yTop + (i % 2 ? 0.4 : -0.4) })

    const angles: FrameAngles[] = s.map((p) => ({
      t: p.t, knee: null, hip: null, ankle: null, torsoLean: null, elbow: null, shoulder: null, metric: true,
    }))
    const series = anglesAgainstBar(angles, verticalVelocity(s))
    const at = stickingPoint(series)
    expect(at).not.toBeNull()
    expect(series[at!].t).toBeGreaterThan(3.0)
    expect(series[at!].t).toBeLessThan(3.5)
  })

  it('has no answer for an ascent that never slowed', () => {
    const s: Sample[] = []
    rep(s, 0, 3.0, 600, 30, 400)
    const angles: FrameAngles[] = s.map((p) => ({
      t: p.t, knee: null, hip: null, ankle: null, torsoLean: null, elbow: null, shoulder: null, metric: true,
    }))
    expect(stickingPoint(anglesAgainstBar(angles, verticalVelocity(s)))).toBeNull()
  })
})

describe('single-set 1RM', () => {
  it('trusts the recorded max over a two-set "profile"', () => {
    // A 250 kg squatter: one saved set at 180 kg / 0.62 m/s, today 185 kg at
    // 0.61 m/s. The two-point profile used to win and estimate 365 kg.
    const mvt = 0.25
    const profile = buildLoadVelocityProfile([{ load: 180, velocity: 0.62 }, { load: 185, velocity: 0.61 }], mvt)
    const slope = resolveLvSlope('back-squat', {
      profile,
      calibration: { knownMax: 250, loadKg: 180, velocity: 0.62, mvt },
    })
    expect(slope.source).toBe('calibrated')
    const estimate = e1RMFromVelocity({ loadKg: 185, velocity: 0.61, mvt, slope })!
    expect(estimate.e1rm).toBeGreaterThan(235)
    expect(estimate.e1rm).toBeLessThan(265)
  })

  it('still uses a real profile once it has three spread loads', () => {
    const mvt = 0.25
    const profile = buildLoadVelocityProfile(
      [
        { load: 140, velocity: 0.8 },
        { load: 170, velocity: 0.64 },
        { load: 200, velocity: 0.48 },
      ],
      mvt,
    )
    expect(resolveLvSlope('back-squat', { profile }).source).toBe('profile')
  })
})
