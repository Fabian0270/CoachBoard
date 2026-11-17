import { describe, expect, it } from 'vitest'
import { compareToReference, referenceShape } from './referenceRep'

// The reference rep (BP28, D57).

const PPM = 200 // a 450 mm plate 90 px across
const rep = (index: number, startT: number, endT: number, romM: number, mean: number) => ({
  index, startT, endT, durationMs: (endT - startT) * 1000, romPx: romM * PPM, meanVelocityPxS: mean * PPM, peakVelocityPxS: mean * 1.3 * PPM,
  romM, meanVelocity: mean, peakVelocity: mean * 1.3, meanPropulsiveVelocity: null, propulsiveFraction: null,
})
// Two reps: down and up 100 px (0.5 m), drifting 10 px (5 cm) right on the second's way up.
const track = Array.from({ length: 61 }, (_, i) => {
  const t = i / 10
  const k = t % 3
  const y = k < 1.5 ? 100 + (k / 1.5) * 100 : 200 - ((k - 1.5) / 1.5) * 100
  return { t, x: 300 + (t > 4.5 ? (t - 4.5) * 6.67 : 0), y }
})
const analysis = (loadKg: number) => ({
  id: 'ref', mediaId: null, athleteId: 'a1', athleteName: 'Anna', sourceLabel: '', track,
  calibration: { a: { x: 0, y: 0 }, b: { x: 0, y: 90 }, plateDiameterMm: 450 },
  metrics: [rep(0, 1.5, 3, 0.5, 0.6), rep(1, 4.5, 6, 0.5, 0.5)], notes: null, hasVideo: false,
  createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z', liftedAt: '2026-11-10T10:00:00Z',
  lift: 'back-squat', loadKg, calledRpe: null, metric: null,
})

describe('referenceShape', () => {
  it("the rep's path in metres from the top before it", () => {
    const s = referenceShape(analysis(180), 0)!
    expect(s.rep.index).toBe(0)
    expect(s.path[0]).toEqual({ x: 0, y: 0 })
    // Half a metre down at the bottom.
    expect(Math.max(...s.path.map((p) => p.y))).toBeCloseTo(0.5, 2)
  })
  it('nothing without a scale, or for a rep the set does not have', () => {
    expect(referenceShape({ ...analysis(180), calibration: null }, 0)).toBeNull()
    expect(referenceShape(analysis(180), 7)).toBeNull()
  })
})

describe('compareToReference', () => {
  it('range and drift always; speed only at the same load', () => {
    const shape = referenceShape(analysis(180), 1)!
    const current = { reps: [rep(0, 1.5, 3, 0.45, 0.55)], track, pixelsPerMetre: PPM }
    const same = compareToReference(shape, { ...current, loadKg: 180 }, 'mean')
    expect(same.sameLoad).toBe(true)
    expect(same.reference.rangeCm).toBeCloseTo(50)
    expect(same.reference.driftCm).toBeCloseTo(5, 0)
    expect(same.reps[0]).toMatchObject({ label: 'Rep 1', rangeCm: 45, speed: 0.55 })
    const other = compareToReference(shape, { ...current, loadKg: 190 }, 'mean')
    expect(other.sameLoad).toBe(false)
    expect(other.reps[0].speed).toBeNull()
    expect(other.reference.speed).toBeNull()
  })
})
