import { describe, it, expect } from 'vitest'
import { findTemplate } from './suggestionTemplates.js'
import { RPE_VALUES } from 'coachboard-shared/rpe'

const ALL_IDS = [
  'hypertrophy_accumulation',
  'hypertrophy_repeated_effort',
  'strength_linear',
  'strength_wave',
  'peaking_standard',
  'peaking_extended',
]

const E1RM = 200
const NO_ADJUST = 0

describe('findTemplate', () => {
  it('returns undefined for unknown id', () => {
    expect(findTemplate('bogus')).toBeUndefined()
  })

  it('finds all six templates', () => {
    for (const id of ALL_IDS) {
      expect(findTemplate(id)).toBeDefined()
    }
  })
})

describe.each(ALL_IDS)('%s', (id) => {
  const template = findTemplate(id)!

  it('returns exactly `weeks` slots', () => {
    for (const weeks of [3, 4, 6, 9]) {
      expect(template.generate(weeks, E1RM, NO_ADJUST)).toHaveLength(weeks)
    }
  })

  it('slot week numbers are 1-based and sequential', () => {
    const slots = template.generate(5, E1RM, NO_ADJUST)
    slots.forEach((s, i) => expect(s.week).toBe(i + 1))
  })

  it('all weights are positive multiples of 2.5', () => {
    const slots = template.generate(6, E1RM, NO_ADJUST)
    for (const s of slots) {
      expect(s.weight).toBeGreaterThan(0)
      expect(s.weight % 2.5).toBeCloseTo(0)
    }
  })

  it('all targetRpe values are valid half-step RPE values', () => {
    const slots = template.generate(6, E1RM, NO_ADJUST)
    const valid = new Set(RPE_VALUES.map(String))
    for (const s of slots) {
      expect(valid.has(String(s.targetRpe))).toBe(true)
    }
  })

  it('all reps are between 1 and 10', () => {
    const slots = template.generate(6, E1RM, NO_ADJUST)
    for (const s of slots) {
      expect(s.reps).toBeGreaterThanOrEqual(1)
      expect(s.reps).toBeLessThanOrEqual(10)
    }
  })

  it('all sets are positive integers', () => {
    const slots = template.generate(6, E1RM, NO_ADJUST)
    for (const s of slots) {
      expect(s.sets).toBeGreaterThan(0)
      expect(Number.isInteger(s.sets)).toBe(true)
    }
  })

  it('explanation string is non-empty', () => {
    const slots = template.generate(4, E1RM, NO_ADJUST)
    for (const s of slots) {
      expect(s.explanation.length).toBeGreaterThan(0)
    }
  })

  it('positive rpeAdjustment produces lighter weights', () => {
    const base    = template.generate(4, E1RM, 0)
    const lighter = template.generate(4, E1RM, 0.025)
    base.forEach((s, i) => expect(lighter[i].weight).toBeLessThanOrEqual(s.weight))
  })

  it('negative rpeAdjustment produces heavier weights', () => {
    const base    = template.generate(4, E1RM, 0)
    const heavier = template.generate(4, E1RM, -0.025)
    base.forEach((s, i) => expect(heavier[i].weight).toBeGreaterThanOrEqual(s.weight))
  })
})

describe('hypertrophy_accumulation', () => {
  const t = findTemplate('hypertrophy_accumulation')!

  it('sets ramp upward across weeks', () => {
    const slots = t.generate(6, E1RM, NO_ADJUST)
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].sets).toBeGreaterThanOrEqual(slots[i - 1].sets)
    }
  })

  it('rpe ramps upward across weeks', () => {
    const slots = t.generate(6, E1RM, NO_ADJUST)
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].targetRpe).toBeGreaterThanOrEqual(slots[i - 1].targetRpe)
    }
  })
})

describe('hypertrophy_repeated_effort', () => {
  const t = findTemplate('hypertrophy_repeated_effort')!

  it('final week is a deload (fewer sets, lower RPE)', () => {
    const slots = t.generate(4, E1RM, NO_ADJUST)
    const last = slots[slots.length - 1]
    const prev = slots[slots.length - 2]
    expect(last.sets).toBeLessThan(prev.sets)
    expect(last.targetRpe).toBeLessThan(prev.targetRpe)
  })

  it('weeks 1-3 all use RPE 8', () => {
    const slots = t.generate(4, E1RM, NO_ADJUST)
    slots.slice(0, 3).forEach((s) => expect(s.targetRpe).toBe(8))
  })
})

describe('strength_wave', () => {
  const t = findTemplate('strength_wave')!

  it('reps follow 5-4-3 repeating pattern', () => {
    const slots = t.generate(6, E1RM, NO_ADJUST)
    const expected = [5, 4, 3, 5, 4, 3]
    slots.forEach((s, i) => expect(s.reps).toBe(expected[i]))
  })

  it('wave 2 RPEs are 0.5 higher than wave 1 at same step', () => {
    const slots = t.generate(6, E1RM, NO_ADJUST)
    ;[0, 1, 2].forEach((step) => {
      expect(slots[step + 3].targetRpe).toBe(snapRpe(slots[step].targetRpe + 0.5))
    })
  })
})

describe('peaking_standard', () => {
  const t = findTemplate('peaking_standard')!

  it('final week is always 1-rep singles', () => {
    for (const weeks of [3, 4, 6]) {
      const slots = t.generate(weeks, E1RM, NO_ADJUST)
      expect(slots[slots.length - 1].reps).toBe(1)
    }
  })

  it('final week RPE is 10', () => {
    const slots = t.generate(4, E1RM, NO_ADJUST)
    expect(slots[slots.length - 1].targetRpe).toBe(10)
  })
})

describe('peaking_extended', () => {
  const t = findTemplate('peaking_extended')!

  it('final week is always 1-rep singles at RPE 10', () => {
    for (const weeks of [5, 6, 8]) {
      const slots = t.generate(weeks, E1RM, NO_ADJUST)
      const last = slots[slots.length - 1]
      expect(last.reps).toBe(1)
      expect(last.targetRpe).toBe(10)
    }
  })

  it('starts at higher volume than standard peak', () => {
    const extended = findTemplate('peaking_extended')!.generate(6, E1RM, NO_ADJUST)
    const standard = findTemplate('peaking_standard')!.generate(4, E1RM, NO_ADJUST)
    expect(extended[0].sets).toBeGreaterThan(standard[0].sets)
    expect(extended[0].reps).toBeGreaterThan(standard[0].reps)
  })
})

// Helper mirroring the internal snapRpe — used only in the wave test above.
function snapRpe(rpe: number): number {
  return Math.min(10, Math.max(5, Math.round(rpe * 2) / 2))
}
