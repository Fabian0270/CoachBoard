import { describe, expect, it } from 'vitest'
import { repSpeeds } from './PathImageButtons'

// The speeds in the image's band (BP24, D49): the set's own reading, in rep order.

const rep = (index: number, startT: number, mean: number | null, meanPxS: number) => ({
  index, startT, endT: startT + 0.9, durationMs: 900, romPx: 200, meanVelocityPxS: meanPxS, peakVelocityPxS: meanPxS * 1.3,
  romM: mean != null ? 0.75 : null, meanVelocity: mean, peakVelocity: mean != null ? mean * 1.3 : null,
  meanPropulsiveVelocity: null, propulsiveFraction: null,
})

describe('repSpeeds', () => {
  it('in m/s, in the order the reps happened', () => {
    expect(repSpeeds([rep(1, 4.4, 0.55, 150), rep(0, 1.8, 0.62, 170)], 'mean')).toEqual(['0.62 m/s', '0.55 m/s'])
  })
  it('in px/s without a scale', () => {
    expect(repSpeeds([rep(0, 1.8, null, 171.4)], 'mean')).toEqual(['171 px/s'])
  })
})
