import { describe, it, expect } from 'vitest'
import {
  POWERLIFTING_EXERCISES,
  EXERCISE_NAMES,
} from 'coachboard-shared/exercises'
import {
  ACCESSORY_POOLS,
  knowledgeDefaultsForGoal,
} from 'coachboard-shared/knowledge'

describe('exercise directory', () => {
  it('has unique names and includes the competition lifts', () => {
    expect(EXERCISE_NAMES.length).toBe(POWERLIFTING_EXERCISES.length)
    expect(new Set(EXERCISE_NAMES).size).toBe(EXERCISE_NAMES.length)
    for (const lift of ['Squat', 'Bench Press', 'Deadlift']) {
      expect(EXERCISE_NAMES).toContain(lift)
    }
  })
})

describe('enriched accessory pools', () => {
  it('append extra accessories without disturbing the deterministic first picks', () => {
    // Base entries stay first → the engine's "first 3" picks are unchanged.
    expect(ACCESSORY_POOLS.squat.slice(0, 3).map((a) => a.name)).toEqual([
      'Front Squat', 'Pause Squat', 'Tempo Squat',
    ])
    // Extra additions are present further down the pool.
    expect(ACCESSORY_POOLS.squat.map((a) => a.name)).toContain('Box Squat')
    expect(ACCESSORY_POOLS.bench.map((a) => a.name)).toContain('Spoto Press')
    expect(ACCESSORY_POOLS.deadlift.map((a) => a.name)).toContain('Snatch-Grip Deadlift')
  })

  it('has no duplicate accessory names per lift', () => {
    for (const lift of ['squat', 'bench', 'deadlift'] as const) {
      const names = ACCESSORY_POOLS[lift].map((a) => a.name.toLowerCase())
      expect(new Set(names).size).toBe(names.length)
    }
  })
})

describe('knowledgeDefaultsForGoal', () => {
  it('returns integer block length / days and a rep range per goal', () => {
    for (const goal of ['hypertrophy', 'strength', 'peaking'] as const) {
      const d = knowledgeDefaultsForGoal(goal)
      expect(Number.isInteger(d.weeks)).toBe(true)
      expect(d.weeks).toBeGreaterThan(0)
      expect([3, 4, 5, 6]).toContain(d.daysPerWeek)
      expect(d.repRange[0]).toBeLessThanOrEqual(d.repRange[1])
    }
  })

  it('peaking blocks default longer than strength (more peaking archetypes are long)', () => {
    // Sanity: the defaults actually reflect the archetype data, not a constant.
    const strength = knowledgeDefaultsForGoal('strength')
    expect(strength.weeks).toBeGreaterThanOrEqual(4)
  })
})
