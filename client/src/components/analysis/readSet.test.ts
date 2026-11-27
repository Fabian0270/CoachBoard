import { describe, it, expect } from 'vitest'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'
import { e1RMFromVelocity, populationSlope, resolveMvt } from 'coachboard-shared/vbt'
import { readSet, type SetReadingInput } from './readSet'

// One set, read the same on the live page and the saved page (BP3).

const rep = (index: number, mean: number, peak = mean * 1.4): RepMetrics => ({
  index, startT: index, endT: index + 0.8, durationMs: 800, romPx: 300, meanVelocityPxS: mean * 600, peakVelocityPxS: peak * 600,
  romM: 0.5, meanVelocity: mean, peakVelocity: peak, meanPropulsiveVelocity: mean * 1.1, propulsiveFraction: 0.9,
})

const base = (over: Partial<SetReadingInput> = {}): SetReadingInput => ({
  reps: [rep(0, 0.55), rep(1, 0.5), rep(2, 0.42)],
  lift: 'back-squat', metric: 'mean', calibrated: true, loadKg: 180, calledRpe: null,
  anchors: [], storedMvt: null, savedPoints: [], maxes: [], ...over,
})

describe('readSet', () => {
  it('reads the last rep for the RPE and the fastest for the max', () => {
    const r = readSet(base())
    expect(r.lastV).toBe(0.42)
    expect(r.bestV).toBe(0.55)
    const mvt = resolveMvt('back-squat', { stored: null, anchors: [] })!
    expect(r.estimate?.e1rm).toBeCloseTo(e1RMFromVelocity({ loadKg: 180, velocity: 0.55, mvt, slope: populationSlope('back-squat') })!.e1rm)
  })

  it('reads nothing in m/s without a scale', () => {
    const r = readSet(base({ calibrated: false }))
    expect([r.lastV, r.bestV, r.reading, r.estimate]).toEqual([null, null, null, null])
  })

  it('reading peak, a mistracked rep is left out — it no longer sets the max', () => {
    // Rep 1's peak is far out of line with its mean: the tracker jumped.
    const reps = [rep(0, 0.4, 0.6), rep(1, 0.38, 1.7), rep(2, 0.35, 0.5)]
    const r = readSet(base({ reps, metric: 'peak' }))
    expect(r.mistracked.map((m) => m.index)).toEqual([1])
    expect(r.bestV).toBe(0.6)
  })

  it("a stored 1RM speed wins over the published one; a typed implausible one is ignored", () => {
    expect(readSet(base({ storedMvt: 0.3 })).mvt).toBe(0.3)
    expect(readSet(base({ storedMvt: 0.3, typedMvt: 25 })).mvt).toBe(0.3)
    expect(readSet(base({ storedMvt: 0.3, typedMvt: 0.28 })).mvt).toBe(0.28)
  })

  it("calibrates against the most recent OTHER saved set, never this one", () => {
    const savedPoints = [{ load: 170, velocity: 0.6, label: '2026-11-01' }, { load: 150, velocity: 0.75, label: '2026-10-01' }]
    const r = readSet(base({ savedPoints, maxes: [{ lift_name: 'Squat', weight: 220 }] }))
    expect(r.calibration).toMatchObject({ knownMax: 220, loadKg: 170, velocity: 0.6 })
    // With no other set there is nothing to calibrate from.
    expect(readSet(base({ maxes: [{ lift_name: 'Squat', weight: 220 }] })).calibration).toBeNull()
  })
})
