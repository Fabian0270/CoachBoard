import { describe, expect, it } from 'vitest'
import { repCsv } from './repCsv'

// A set as CSV (BP42).

const rep = (index: number, startT: number, calibrated: boolean) => ({
  index, startT, endT: startT + 0.9, durationMs: 900, romPx: 200, meanVelocityPxS: 150, peakVelocityPxS: 200,
  romM: calibrated ? 0.75 : null, meanVelocity: calibrated ? 0.55 : null, peakVelocity: calibrated ? 0.74 : null,
  meanPropulsiveVelocity: calibrated ? 0.6 : null, propulsiveFraction: calibrated ? 0.9 : null,
})

describe('repCsv', () => {
  it('one rep a row, in m/s and cm with a scale, rep order, struck reps marked', () => {
    const csv = repCsv([rep(1, 4.4, true), rep(0, 1.8, true)], { pixelsPerMetre: 266.7, excluded: new Set([1]) })
    const [head, first, second] = csv.trim().split('\r\n')
    expect(head).toBe('rep,mean m/s,propulsive m/s,peak m/s,range cm,sideways max cm,sideways at top cm,down s,pause s,up s,counted')
    expect(first).toBe('1,0.550,0.600,0.740,75.0,,,,,0.90,yes')
    expect(second).toBe('2,0.550,0.600,0.740,75.0,,,,,0.90,no')
  })

  it('in px/s and px without a scale', () => {
    const csv = repCsv([rep(0, 1.8, false)], { pixelsPerMetre: null })
    expect(csv.split('\r\n')[0]).toContain('mean px/s')
    expect(csv.split('\r\n')[1]).toBe('1,150,,200,200,,,,,0.90,yes')
  })
})
