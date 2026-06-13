import { describe, it, expect } from 'vitest'
import { pctOf1RM, estimate1RM, targetWeight, RPE_VALUES, MIN_REPS, MAX_REPS } from 'coachboard-shared/rpe'

describe('pctOf1RM', () => {
  it('returns 100% for 1 rep at RPE 10', () => {
    expect(pctOf1RM(1, 10)).toBe(1)
  })

  it('matches well-known chart anchors', () => {
    expect(pctOf1RM(1, 9)).toBeCloseTo(0.955, 3) // 1 @ 9
    expect(pctOf1RM(5, 8)).toBeCloseTo(0.811, 3) // the classic 5 @ 8 ≈ 81%
    expect(pctOf1RM(3, 8.5)).toBeCloseTo(0.878, 3)
    expect(pctOf1RM(10, 6.5)).toBeCloseTo(0.64, 3) // bottom-left corner
  })

  it('is diagonal: one more rep equals one full RPE lower', () => {
    for (let reps = MIN_REPS; reps < MAX_REPS; reps++) {
      for (const rpe of RPE_VALUES) {
        if (rpe - 1 < RPE_VALUES[0]) continue
        expect(pctOf1RM(reps + 1, rpe)).toBe(pctOf1RM(reps, rpe - 1))
      }
    }
  })

  it('decreases as reps go up at fixed RPE', () => {
    for (let reps = MIN_REPS; reps < MAX_REPS; reps++) {
      expect(pctOf1RM(reps + 1, 8)!).toBeLessThan(pctOf1RM(reps, 8)!)
    }
  })

  it('returns null outside the chart', () => {
    expect(pctOf1RM(0, 8)).toBeNull()
    expect(pctOf1RM(11, 8)).toBeNull()
    expect(pctOf1RM(2.5, 8)).toBeNull()
    expect(pctOf1RM(5, 6)).toBeNull()
    expect(pctOf1RM(5, 10.5)).toBeNull()
    expect(pctOf1RM(5, 8.3)).toBeNull() // only half steps
  })
})

describe('estimate1RM', () => {
  it('estimates from a performed set', () => {
    // 150 kg x 5 @ RPE 8 → 150 / 0.811 ≈ 184.96
    expect(estimate1RM(150, 5, 8)).toBeCloseTo(184.96, 1)
  })

  it('a 1RM at RPE 10 is its own estimate', () => {
    expect(estimate1RM(200, 1, 10)).toBe(200)
  })

  it('returns null for invalid input', () => {
    expect(estimate1RM(0, 5, 8)).toBeNull()
    expect(estimate1RM(-10, 5, 8)).toBeNull()
    expect(estimate1RM(150, 15, 8)).toBeNull()
  })
})

describe('targetWeight', () => {
  it('prescribes from a 1RM, rounded to 2.5 kg', () => {
    // 200 × 0.811 = 162.2 → 162.5
    expect(targetWeight(200, 5, 8)).toBe(162.5)
  })

  it('supports other rounding increments', () => {
    expect(targetWeight(200, 5, 8, 1.25)).toBe(162.5)
    expect(targetWeight(100, 5, 8, 1.25)).toBe(81.25)
  })

  it('full chart for a 200 kg max stays within sane bounds', () => {
    for (let reps = MIN_REPS; reps <= MAX_REPS; reps++) {
      for (const rpe of RPE_VALUES) {
        const w = targetWeight(200, reps, rpe)
        expect(w).not.toBeNull()
        expect(w!).toBeGreaterThanOrEqual(200 * 0.6)
        expect(w!).toBeLessThanOrEqual(200)
      }
    }
  })

  it('returns null for invalid input', () => {
    expect(targetWeight(0, 5, 8)).toBeNull()
    expect(targetWeight(200, 5, 8, 0)).toBeNull()
    expect(targetWeight(200, 5, 5)).toBeNull()
  })
})
