import { describe, expect, it } from 'vitest'
import { describeTarget, judgeSet, parseVelocityTarget } from 'coachboard-shared/velocityTarget'

// BP39 (D72, D75): reading a Velocity cell and judging a set against it.

describe('parseVelocityTarget', () => {
  it.each([
    ['0.50', { min: 0.5, max: null, lossPct: null }],
    ['0,5 m/s', { min: 0.5, max: null, lossPct: null }],
    ['.5', { min: 0.5, max: null, lossPct: null }],
    ['≥0.45', { min: 0.45, max: null, lossPct: null }],
    ['0.45-0.55', { min: 0.45, max: 0.55, lossPct: null }],
    ['0.55 – 0.45', { min: 0.45, max: 0.55, lossPct: null }],
    ['0.45 to 0.55 m/s', { min: 0.45, max: 0.55, lossPct: null }],
    ['VL 20%', { min: null, max: null, lossPct: 20 }],
    ['-20 %', { min: null, max: null, lossPct: 20 }],
    ['0.50 · VL 20%', { min: 0.5, max: null, lossPct: 20 }],
    ['0.45-0.55 / 15%', { min: 0.45, max: 0.55, lossPct: 15 }],
  ])('%s', (text, want) => {
    expect(parseVelocityTarget(text)).toEqual(want)
  })

  it('nothing it can read is no target', () => {
    expect(parseVelocityTarget('')).toBeNull()
    expect(parseVelocityTarget('fast')).toBeNull()
    expect(parseVelocityTarget('RPE 8')).toBeNull()
    expect(parseVelocityTarget(null)).toBeNull()
  })

  it('describes itself', () => {
    expect(describeTarget({ min: 0.5, max: null, lossPct: 20 })).toBe('0.50 m/s or faster · stop at 20 % loss')
    expect(describeTarget({ min: 0.45, max: 0.55, lossPct: null })).toBe('0.45–0.55 m/s')
  })
})

const rep = (index: number, mean: number) => ({
  index, startT: index * 3, endT: index * 3 + 1, durationMs: 1000, romPx: 100, meanVelocityPxS: mean * 200, peakVelocityPxS: mean * 260,
  romM: 0.5, meanVelocity: mean, peakVelocity: mean * 1.3, meanPropulsiveVelocity: null, propulsiveFraction: null,
})

describe('judgeSet', () => {
  const set = [rep(0, 0.6), rep(1, 0.58), rep(2, 0.52), rep(3, 0.47), rep(4, 0.44)]

  it('at least the speed: counts the reps inside and marks the slow ones', () => {
    const v = judgeSet(set, 'mean', { min: 0.5, max: null, lossPct: null })
    expect(v.speed).toEqual({ inside: 3, total: 5, slowest: 0.44 })
    expect([...v.marks]).toEqual([[3, ['slow']], [4, ['slow']]])
    expect(v.cutoffAt).toBeNull()
  })

  it('a range marks the too-fast reps too', () => {
    const v = judgeSet(set, 'mean', { min: 0.45, max: 0.55, lossPct: null })
    expect(v.speed?.inside).toBe(2)
    expect(v.marks.get(0)).toEqual(['fast'])
    expect(v.marks.get(4)).toEqual(['slow'])
  })

  it('the loss cut-off: the rep that reached it, and the reps past it', () => {
    const v = judgeSet(set, 'mean', { min: null, max: null, lossPct: 20 })
    // 0.47 is 21.7 % under 0.60.
    expect(v.cutoffAt).toBe(4)
    expect(v.losses.get(3)).toBeCloseTo(21.7, 1)
    expect(v.marks.get(3)).toEqual(['cutoff'])
    expect(v.marks.get(4)).toEqual(['past-cutoff'])
    expect(v.speed).toBeNull()
  })

  it('loss is from the fastest rep so far, not the first', () => {
    const v = judgeSet([rep(0, 0.5), rep(1, 0.6), rep(2, 0.5)], 'mean', { min: null, max: null, lossPct: 15 })
    expect(v.losses.get(1)).toBe(0)
    expect(v.cutoffAt).toBe(3)
  })

  it('reads the set in its own metric', () => {
    const v = judgeSet([rep(0, 0.5)], 'peak', { min: 0.6, max: null, lossPct: null })
    expect(v.speed?.inside).toBe(1)
  })
})
