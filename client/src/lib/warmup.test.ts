import { describe, it, expect } from 'vitest'
import { warmupPlan, epley1RM, platesPerSide, WARMUP_SCHEME } from 'coachboard-shared/warmup'

describe('warmupPlan', () => {
  it('produces the StrengthLog 7-set protocol plus the max attempt', () => {
    const sets = warmupPlan(200)
    expect(sets).toHaveLength(8)
    expect(sets.map((s) => s.pct)).toEqual([40, 50, 60, 70, 80, 90, 95, 100])
    expect(sets.map((s) => s.reps)).toEqual([8, 5, 4, 3, 2, 1, 1, 1])
    expect(sets[sets.length - 1].isMax).toBe(true)
  })

  it('rounds weights to the increment and tops out at the target', () => {
    const sets = warmupPlan(200, { rounding: 2.5 })
    // 40% of 200 = 80, 90% = 180, max = 200.
    expect(sets[0].weight).toBe(80)
    expect(sets[5].weight).toBe(180)
    expect(sets[7].weight).toBe(200)
    for (const s of sets) expect(s.weight % 2.5).toBe(0)
  })

  it('weights never drop below the empty bar', () => {
    const sets = warmupPlan(40, { barWeight: 20 })
    expect(sets[0].weight).toBeGreaterThanOrEqual(20)
  })

  it('is monotonically non-decreasing', () => {
    const sets = warmupPlan(187.5)
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i].weight).toBeGreaterThanOrEqual(sets[i - 1].weight)
    }
  })

  it('returns [] for a non-positive 1RM', () => {
    expect(warmupPlan(0)).toEqual([])
    expect(warmupPlan(-100)).toEqual([])
  })

  it('exposes the scheme as data with rising rest', () => {
    expect(WARMUP_SCHEME.map((s) => s.restMinutes)).toEqual([1, 2, 2, 2, 3, 3, 5, null])
  })
})

describe('epley1RM', () => {
  it('matches the Epley formula 1RM = w(1 + reps/30)', () => {
    expect(epley1RM(100, 1)).toBeCloseTo(103.33, 1)
    expect(epley1RM(100, 5)).toBeCloseTo(116.67, 1)
    expect(epley1RM(100, 10)).toBeCloseTo(133.33, 1)
  })

  it('rejects invalid input', () => {
    expect(epley1RM(0, 5)).toBeNull()
    expect(epley1RM(100, 0)).toBeNull()
  })
})

describe('platesPerSide', () => {
  it('breaks a weight into standard kg plates', () => {
    expect(platesPerSide(100, 20)).toEqual([25, 15]) // 80/2 = 40 per side = 25+15 (greedy)
    expect(platesPerSide(140, 20)).toEqual([25, 25, 10]) // 120/2 = 60 = 25+25+10 (greedy)
  })

  it('returns [] when only the bar is loaded', () => {
    expect(platesPerSide(20, 20)).toEqual([])
    expect(platesPerSide(15, 20)).toEqual([])
  })
})
