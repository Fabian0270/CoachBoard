import { describe, it, expect } from 'vitest'
import {
  fitLine,
  lrvChart,
  rpeFromLastRepVelocity,
  resolveAnchors,
  buildLoadVelocityProfile,
  e1RMFromVelocity,
  calibratedSlope,
  populationSlope,
  resolveLvSlope,
  recordedMaxFor,
  matchesLiftName,
  effectiveRpe,
  defaultMvt,
  defaultVelocityMetric,
  DEFAULT_LV_SLOPE,
  zoneFor,
  velocityLoss,
  lastRepVelocity,
  bestRepVelocity,
  isVbtLift,
  LRV_ANCHORS,
  LRV_TOLERANCE_MS,
  VELOCITY_ZONES,
  MVT_RANGE,
} from 'coachboard-shared/vbt'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'

// A coach loads a bar based on what this module says, so every case here is
// built from inputs whose true answer is known in advance — the same approach
// videoAnalysis.test.ts takes with synthetic paths.

/** A rep carrying only the fields these functions read. */
function rep(meanVelocity: number | null, pxS = 100): RepMetrics {
  return {
    index: 0,
    startT: 0,
    endT: 1,
    durationMs: 1000,
    romPx: 200,
    meanVelocityPxS: pxS,
    peakVelocityPxS: pxS * 1.5,
    romM: null,
    meanVelocity,
    peakVelocity: meanVelocity == null ? null : meanVelocity * 1.5,
  }
}

describe('fitLine', () => {
  it('recovers an exact line exactly', () => {
    // y = 3 + 2x
    const fit = fitLine([
      { x: 0, y: 3 },
      { x: 1, y: 5 },
      { x: 4, y: 11 },
    ])
    expect(fit).not.toBeNull()
    expect(fit!.slope).toBeCloseTo(2, 12)
    expect(fit!.intercept).toBeCloseTo(3, 12)
    expect(fit!.r2).toBeCloseTo(1, 12)
    expect(fit!.n).toBe(3)
  })

  it('refuses a fit rather than returning Infinity when every x is the same', () => {
    // Three sets all at the same load: a real case, and the one that would
    // otherwise divide by zero and produce a confident nonsense 1RM.
    expect(fitLine([{ x: 100, y: 0.5 }, { x: 100, y: 0.4 }, { x: 100, y: 0.45 }])).toBeNull()
  })

  it('refuses a fit on fewer than two points', () => {
    expect(fitLine([{ x: 1, y: 1 }])).toBeNull()
    expect(fitLine([])).toBeNull()
  })

  it('reports a perfect fit when every y is identical', () => {
    const fit = fitLine([{ x: 1, y: 0.5 }, { x: 2, y: 0.5 }, { x: 3, y: 0.5 }])
    expect(fit!.slope).toBeCloseTo(0, 12)
    expect(fit!.r2).toBe(1)
  })

  it('rejects non-finite inputs instead of propagating NaN', () => {
    expect(fitLine([{ x: 1, y: 1 }, { x: 2, y: Number.NaN }])).toBeNull()
  })
})

describe('lrvChart', () => {
  it('reproduces the published back squat anchors', () => {
    const chart = lrvChart('back-squat')!
    const at = (rpe: number) => chart.rows.find((r) => r.rpe === rpe)!.velocity
    expect(at(10)).toBeCloseTo(0.25, 6)
    expect(at(8.5)).toBeCloseTo(0.35, 6)
    expect(at(7)).toBeCloseTo(0.45, 6)
    expect(chart.source).toBe('published')
  })

  it('reproduces every published anchor exactly, bent tables included', () => {
    // Bench and sumo anchors are not collinear, so a regression through them
    // would miss the source's own numbers. A coach must be able to look the
    // chart up against the article and find it unchanged.
    for (const [lift, anchors] of Object.entries(LRV_ANCHORS)) {
      const chart = lrvChart(lift as never)!
      for (const anchor of anchors!) {
        const row = chart.rows.find((r) => r.rpe === anchor.rpe)!
        expect(row.velocity, `${lift} @ RPE ${anchor.rpe}`).toBeCloseTo(anchor.velocity, 9)
      }
    }
  })

  it('covers the whole 5-10 scale in half steps', () => {
    const chart = lrvChart('bench-press')!
    expect(chart.rows).toHaveLength(11)
    expect(chart.rows[0].rpe).toBe(5)
    expect(chart.rows[10].rpe).toBe(10)
  })

  it('slopes downward for every published lift — slower bar means higher RPE', () => {
    for (const lift of Object.keys(LRV_ANCHORS)) {
      const chart = lrvChart(lift as never)!
      expect(chart.fit.slope).toBeLessThan(0)
    }
  })

  it('returns null for a lift with no published anchors', () => {
    // The press has a published MVT but no LRV table, so the honest answer is
    // no chart rather than a fabricated one.
    expect(MVT_RANGE['overhead-press']).toBeDefined()
    expect(lrvChart('overhead-press')).toBeNull()
    expect(lrvChart('other')).toBeNull()
  })

  it('builds a chart for an unlisted lift from the athlete\'s own anchors', () => {
    const chart = lrvChart('other', [
      { rpe: 7, velocity: 0.6 },
      { rpe: 8.5, velocity: 0.45 },
      { rpe: 10, velocity: 0.3 },
    ])!
    expect(chart.source).toBe('personal')
    expect(chart.rows.find((r) => r.rpe === 8.5)!.velocity).toBeCloseTo(0.45, 6)
  })
})

describe('resolveAnchors', () => {
  const personal = [
    { rpe: 7, velocity: 0.5 },
    { rpe: 8.5, velocity: 0.4 },
    { rpe: 10, velocity: 0.3 },
  ]

  it('prefers the athlete over the published table once there are enough anchors', () => {
    expect(resolveAnchors('back-squat', personal)!.source).toBe('personal')
  })

  it('falls back to published below three anchors', () => {
    expect(resolveAnchors('back-squat', personal.slice(0, 2))!.source).toBe('published')
  })

  it('falls back to published when every anchor is at the same RPE', () => {
    // Three sets all called RPE 8 say nothing about the slope, however many there are.
    const flat = [
      { rpe: 8, velocity: 0.42 },
      { rpe: 8, velocity: 0.40 },
      { rpe: 8, velocity: 0.44 },
    ]
    expect(resolveAnchors('back-squat', flat)!.source).toBe('published')
  })
})

describe('rpeFromLastRepVelocity', () => {
  it('round-trips against every published chart', () => {
    for (const lift of Object.keys(LRV_ANCHORS)) {
      const chart = lrvChart(lift as never)!
      for (const row of chart.rows) {
        const back = rpeFromLastRepVelocity(lift as never, row.velocity)!
        expect(back.rawRpe, `${lift} @ ${row.velocity}`).toBeCloseTo(row.rpe, 6)
      }
    }
  })

  it('reads a slow bench single as a max effort', () => {
    // Published bench RPE 10 is 0.20 m/s.
    expect(rpeFromLastRepVelocity('bench-press', 0.2)!.rpe).toBe(10)
  })

  it('clamps below the chart and says so', () => {
    // Far faster than RPE 5 on a back squat.
    const reading = rpeFromLastRepVelocity('back-squat', 1.2)!
    expect(reading.rpe).toBe(5)
    expect(reading.rawRpe).toBeLessThan(5)
    expect(reading.outsideChart).toBe(true)
  })

  it('clamps above the chart and says so', () => {
    const reading = rpeFromLastRepVelocity('back-squat', 0.05)!
    expect(reading.rpe).toBe(10)
    expect(reading.outsideChart).toBe(true)
  })

  it('calls a set harder than the athlete did when the bar moved slower', () => {
    // Called 7 (0.45 predicted), bar did 0.35 — that is an 8.5.
    const reading = rpeFromLastRepVelocity('back-squat', 0.35, { calledRpe: 7 })!
    expect(reading.agreement).toBe('harder')
    expect(reading.rpe).toBe(8.5)
  })

  it('calls a set easier than the athlete did when the bar moved faster', () => {
    expect(rpeFromLastRepVelocity('back-squat', 0.45, { calledRpe: 9 })!.agreement).toBe('easier')
  })

  it('agrees inside the published tolerance band', () => {
    const inside = 0.45 - LRV_TOLERANCE_MS * 0.9
    expect(rpeFromLastRepVelocity('back-squat', inside, { calledRpe: 7 })!.agreement).toBe('match')
  })

  it('returns null on an unusable velocity or an unknown lift', () => {
    expect(rpeFromLastRepVelocity('back-squat', 0)).toBeNull()
    expect(rpeFromLastRepVelocity('other', 0.4)).toBeNull()
  })
})

describe('e1RMFromVelocity', () => {
  it('estimates a max from one set, straight off the velocity', () => {
    // The real clip this was built from: 205 kg back squat, last rep 0.47 m/s,
    // published MVT 0.25. 100 - 75*(0.47-0.25) = 83.5% -> 245.5 kg, against a
    // 250 kg competition squat with a little left in the tank.
    const e = e1RMFromVelocity({
      loadKg: 205,
      velocity: 0.47,
      mvt: 0.25,
      slope: populationSlope('back-squat'),
    })!
    expect(e.pctOf1RM).toBeCloseTo(0.835, 9)
    expect(e.e1rm).toBeCloseTo(205 / 0.835, 6)
    expect(e.slope.source).toBe('estimated')
  })

  it('returns the load itself when the bar is at the threshold-implied max', () => {
    const e = e1RMFromVelocity({
      loadKg: 200,
      velocity: 0.2501,
      mvt: 0.25,
      slope: { slope: 75, source: 'estimated' },
    })!
    expect(e.e1rm).toBeCloseTo(200, 1)
  })

  it('uses the published slope for the conventional deadlift and a default elsewhere', () => {
    expect(populationSlope('deadlift-conventional')).toEqual({ slope: 80.2, source: 'published' })
    expect(populationSlope('back-squat')).toEqual({ slope: DEFAULT_LV_SLOPE, source: 'estimated' })
    expect(populationSlope('other')).toEqual({ slope: DEFAULT_LV_SLOPE, source: 'estimated' })
  })

  it('refuses when the bar is already at or below the threshold', () => {
    const slope = populationSlope('back-squat')
    expect(e1RMFromVelocity({ loadKg: 205, velocity: 0.25, mvt: 0.25, slope })).toBeNull()
    expect(e1RMFromVelocity({ loadKg: 205, velocity: 0.2, mvt: 0.25, slope })).toBeNull()
  })

  it('refuses a bar so fast the straight line stops describing it', () => {
    // 1.6 m/s against a 0.25 threshold drives the predicted %1RM to zero.
    expect(
      e1RMFromVelocity({ loadKg: 60, velocity: 1.6, mvt: 0.25, slope: populationSlope('back-squat') }),
    ).toBeNull()
  })
})

describe('calibratedSlope', () => {
  it('derives the athlete\'s own slope from a recorded max and one set', () => {
    // 205 at a known 250 max is 82%; 18 percentage points over 0.22 m/s.
    const slope = calibratedSlope({ knownMax: 250, loadKg: 205, velocity: 0.47, mvt: 0.25 })!
    expect(slope).toBeCloseTo(18 / 0.22, 9)
    // Steeper than the population default, which is why generic tables read him low.
    expect(slope).toBeGreaterThan(DEFAULT_LV_SLOPE)
  })

  it('reproduces the recorded max when applied back to the same set', () => {
    const slope = calibratedSlope({ knownMax: 250, loadKg: 205, velocity: 0.47, mvt: 0.25 })!
    const e = e1RMFromVelocity({
      loadKg: 205,
      velocity: 0.47,
      mvt: 0.25,
      slope: { slope, source: 'calibrated' },
    })!
    expect(e.e1rm).toBeCloseTo(250, 6)
  })

  it('refuses when the two anchors collapse onto each other', () => {
    expect(calibratedSlope({ knownMax: 250, loadKg: 250, velocity: 0.47, mvt: 0.25 })).toBeNull()
    expect(calibratedSlope({ knownMax: 250, loadKg: 260, velocity: 0.47, mvt: 0.25 })).toBeNull()
    expect(calibratedSlope({ knownMax: 250, loadKg: 205, velocity: 0.25, mvt: 0.25 })).toBeNull()
  })
})

describe('resolveLvSlope', () => {
  const calibration = { knownMax: 250, loadKg: 205, velocity: 0.47, mvt: 0.25 }

  it('prefers a fitted profile over everything', () => {
    // v = 1.0 - 0.004*load, MVT 0.20 -> 1RM 200 kg.
    const profile = buildLoadVelocityProfile(
      [
        { load: 100, velocity: 0.6 },
        { load: 140, velocity: 0.44 },
        { load: 170, velocity: 0.32 },
      ],
      0.2,
    )!
    const resolved = resolveLvSlope('back-squat', { profile, calibration })
    expect(resolved.source).toBe('profile')
    // -(100/200)/-0.004 = 125 %1RM per m/s.
    expect(resolved.slope).toBeCloseTo(125, 6)
  })

  it('falls to a calibration off a recorded max', () => {
    const resolved = resolveLvSlope('back-squat', { calibration })
    expect(resolved.source).toBe('calibrated')
    expect(resolved.slope).toBeCloseTo(18 / 0.22, 9)
  })

  it('falls to the population slope with nothing else to go on', () => {
    expect(resolveLvSlope('back-squat').source).toBe('estimated')
    expect(resolveLvSlope('deadlift-conventional').source).toBe('published')
  })

  it('ignores a profile that could not produce a max', () => {
    const backwards = buildLoadVelocityProfile(
      [
        { load: 100, velocity: 0.3 },
        { load: 140, velocity: 0.45 },
      ],
      0.2,
    )!
    expect(resolveLvSlope('back-squat', { profile: backwards, calibration }).source).toBe('calibrated')
  })
})

describe('recordedMaxFor', () => {
  const maxes = [
    { lift_name: 'Squat', weight: 250 },
    { lift_name: 'Front Squat', weight: 180 },
    { lift_name: 'Bench Press', weight: 150 },
    { lift_name: 'Deadlift', weight: 280 },
    { lift_name: 'Sumo Deadlift', weight: 285 },
  ]

  it('matches the coach\'s free text to the right lift', () => {
    expect(recordedMaxFor('back-squat', maxes)).toBe(250)
    expect(recordedMaxFor('front-squat', maxes)).toBe(180)
    expect(recordedMaxFor('bench-press', maxes)).toBe(150)
    expect(recordedMaxFor('deadlift-conventional', maxes)).toBe(280)
    expect(recordedMaxFor('deadlift-sumo', maxes)).toBe(285)
  })

  it('does not let a variation stand in for the competition lift', () => {
    expect(matchesLiftName('back-squat', 'Front Squat')).toBe(false)
    expect(matchesLiftName('back-squat', 'Box Squat')).toBe(false)
    expect(matchesLiftName('overhead-press', 'Bench Press')).toBe(false)
    expect(matchesLiftName('deadlift-conventional', 'Romanian Deadlift')).toBe(false)
    expect(matchesLiftName('deadlift-conventional', 'Trap Bar Deadlift')).toBe(false)
  })

  it('takes the heaviest, since a max is a PR and the history is kept', () => {
    expect(recordedMaxFor('back-squat', [
      { lift_name: 'Squat', weight: 250 },
      { lift_name: 'squat', weight: 242.5 },
    ])).toBe(250)
  })

  it('has no answer for a lift with no recorded max', () => {
    expect(recordedMaxFor('barbell-row', maxes)).toBeNull()
    expect(recordedMaxFor('other', maxes)).toBeNull()
  })
})

describe('effectiveRpe', () => {
  it('keeps the coach\'s number when the bar agrees and takes over when it does not', () => {
    const agrees = rpeFromLastRepVelocity('back-squat', 0.47, { calledRpe: 7 })!
    expect(effectiveRpe(agrees, 7)).toBe(7)

    const disagrees = rpeFromLastRepVelocity('back-squat', 0.47, { calledRpe: 9 })!
    expect(effectiveRpe(disagrees, 9)).toBe(6.5)

    const uncalled = rpeFromLastRepVelocity('back-squat', 0.47)!
    expect(effectiveRpe(uncalled, null)).toBe(6.5)
  })
})

describe('buildLoadVelocityProfile', () => {
  // v = 1.0 - 0.004·load, so v hits an MVT of 0.20 at exactly 200 kg.
  const clean = [
    { load: 100, velocity: 0.6 },
    { load: 140, velocity: 0.44 },
    { load: 170, velocity: 0.32 },
  ]

  it('extrapolates a 1RM at the MVT', () => {
    const profile = buildLoadVelocityProfile(clean, 0.2)!
    expect(profile.oneRm).toBeCloseTo(200, 6)
    expect(profile.fit.slope).toBeCloseTo(-0.004, 9)
    expect(profile.fit.r2).toBeCloseTo(1, 9)
    expect(profile.warnings).toEqual([])
  })

  it('prescribes a load for a target velocity and reads %1RM back', () => {
    const profile = buildLoadVelocityProfile(clean, 0.2)!
    expect(profile.loadForVelocity(0.6)).toBeCloseTo(100, 6)
    expect(profile.velocityForLoad(150)).toBeCloseTo(0.4, 9)
    expect(profile.pctOf1RM(150)).toBeCloseTo(0.75, 9)
  })

  it('flags a profile built on two sets', () => {
    expect(buildLoadVelocityProfile(clean.slice(0, 2), 0.2)!.warnings).toContain('too-few-points')
  })

  it('flags loads bunched too closely together', () => {
    // Same line, but every set within 6 kg — under 15% of the 200 kg it projects.
    const bunched = [
      { load: 100, velocity: 0.6 },
      { load: 103, velocity: 0.588 },
      { load: 106, velocity: 0.576 },
    ]
    const profile = buildLoadVelocityProfile(bunched, 0.2)!
    expect(profile.warnings).toContain('narrow-load-range')
    expect(profile.warnings).not.toContain('poor-fit')
  })

  it('flags a scattered fit', () => {
    const scattered = [
      { load: 100, velocity: 0.6 },
      { load: 140, velocity: 0.7 },
      { load: 170, velocity: 0.32 },
    ]
    expect(buildLoadVelocityProfile(scattered, 0.2)!.warnings).toContain('poor-fit')
  })

  it('refuses a 1RM when the bar got faster as the bar got heavier', () => {
    const backwards = [
      { load: 100, velocity: 0.3 },
      { load: 140, velocity: 0.45 },
      { load: 170, velocity: 0.6 },
    ]
    const profile = buildLoadVelocityProfile(backwards, 0.2)!
    expect(profile.warnings).toContain('positive-slope')
    expect(profile.oneRm).toBeNull()
  })

  it('returns null when there is no line to fit', () => {
    expect(buildLoadVelocityProfile([{ load: 100, velocity: 0.5 }], 0.2)).toBeNull()
    expect(buildLoadVelocityProfile(clean, 0)).toBeNull()
  })

  it('drops unusable points rather than poisoning the fit', () => {
    const profile = buildLoadVelocityProfile([...clean, { load: 0, velocity: 0.9 }], 0.2)!
    expect(profile.points).toHaveLength(3)
    expect(profile.oneRm).toBeCloseTo(200, 6)
  })
})

describe('defaultMvt', () => {
  it('takes the RPE 10 row of the lift\'s own chart', () => {
    expect(defaultMvt('back-squat')).toBeCloseTo(0.25, 6)
    expect(defaultMvt('deadlift-sumo')).toBeCloseTo(0.15, 6)
  })

  it('falls back to the middle of the published range for a lift with no chart', () => {
    // Press: novice 0.35, elite 0.20.
    expect(defaultMvt('overhead-press')).toBeCloseTo(0.275, 6)
  })

  it('personalises once the athlete has anchors', () => {
    const mvt = defaultMvt('back-squat', [
      { rpe: 7, velocity: 0.55 },
      { rpe: 8.5, velocity: 0.45 },
      { rpe: 10, velocity: 0.35 },
    ])
    expect(mvt).toBeCloseTo(0.35, 6)
  })

  it('has nothing to offer for an unlisted lift', () => {
    expect(defaultMvt('other')).toBeNull()
  })
})

describe('zoneFor', () => {
  it('places velocities in the expected band', () => {
    expect(zoneFor(0.3)!.id).toBe('absolute-strength')
    expect(zoneFor(0.8)!.id).toBe('strength-speed')
    expect(zoneFor(1.5)!.id).toBe('starting-strength')
  })

  it('leaves no gaps between bands', () => {
    for (let i = 1; i < VELOCITY_ZONES.length; i++) {
      expect(VELOCITY_ZONES[i].min).toBe(VELOCITY_ZONES[i - 1].max)
    }
  })

  it('has no band below the slowest one', () => {
    expect(zoneFor(0.1)).toBeNull()
  })
})

describe('velocityLoss', () => {
  it('measures the drop from the fastest rep to the last', () => {
    const reading = velocityLoss([rep(0.5), rep(0.45), rep(0.42), rep(0.4)])!
    expect(reading.lossPct).toBeCloseTo(20, 9)
    expect(reading.reliable).toBe(true)
  })

  it('marks short sets unreliable', () => {
    expect(velocityLoss([rep(0.5), rep(0.45), rep(0.4)])!.reliable).toBe(false)
    expect(velocityLoss([rep(0.5), rep(0.45), rep(0.42), rep(0.4)])!.reliable).toBe(true)
  })

  it('still works without a scale, since a ratio has no units', () => {
    const reading = velocityLoss([rep(null, 100), rep(null, 90), rep(null, 85), rep(null, 80)])!
    expect(reading.lossPct).toBeCloseTo(20, 9)
    expect(reading.uncalibrated).toBe(true)
  })

  it('needs at least two reps', () => {
    expect(velocityLoss([rep(0.5)])).toBeNull()
    expect(velocityLoss([])).toBeNull()
  })
})

describe('reading a set', () => {
  it('takes the last rep for LRV and the fastest for the profile', () => {
    const reps = [rep(0.5), rep(0.55), rep(0.4)]
    expect(lastRepVelocity(reps)).toBe(0.4)
    expect(bestRepVelocity(reps)).toBe(0.55)
  })

  it('reads peak when asked, since bench is judged on it', () => {
    const reps = [rep(0.5), rep(0.4)]
    // The helper builds peak as 1.5x mean.
    expect(lastRepVelocity(reps, 'peak')).toBeCloseTo(0.6, 9)
    expect(bestRepVelocity(reps, 'peak')).toBeCloseTo(0.75, 9)
  })

  it('defaults bench to peak and everything else to mean', () => {
    // Measured on real clips: bench 170 kg reads 175 kg off the mean and 195 off
    // the peak against a 200 kg max, while a squat read off peak estimates 459.
    expect(defaultVelocityMetric('bench-press')).toBe('peak')
    expect(defaultVelocityMetric('back-squat')).toBe('mean')
    expect(defaultVelocityMetric('deadlift-conventional')).toBe('mean')
    expect(defaultVelocityMetric('other')).toBe('mean')
  })

  it('turns the bench clip that started this into a believable max', () => {
    const bench = [rep(0.24, 0)] // peak 0.36 by the helper's 1.5x
    const off = (metric: 'mean' | 'peak') =>
      e1RMFromVelocity({
        loadKg: 170,
        velocity: bestRepVelocity(bench, metric)!,
        mvt: 0.2,
        slope: populationSlope('bench-press'),
      })!.e1rm
    // Against a real 200 kg bench.
    expect(off('mean')).toBeLessThan(180)
    expect(off('peak')).toBeGreaterThan(190)
  })

  it('has no last-rep velocity without a scale', () => {
    // px/s compared against a published m/s table would be silently nonsensical.
    expect(lastRepVelocity([rep(null)])).toBeNull()
    expect(bestRepVelocity([rep(null)])).toBeNull()
  })
})

describe('isVbtLift', () => {
  it('accepts stored ids and rejects anything else', () => {
    expect(isVbtLift('back-squat')).toBe(true)
    expect(isVbtLift('squat')).toBe(false)
    expect(isVbtLift(null)).toBe(false)
  })
})
