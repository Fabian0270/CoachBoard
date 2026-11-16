import { describe, it, expect } from 'vitest'
import { competitionLiftKey, mainLiftKey, bestStoredMax } from 'coachboard-shared/vbt'

// The server grouped exercises into squat / bench / deadlift by substring, so
// variations were counted as the competition lift in drafts, reports and the
// e1RM badge. These pin which names are the lift and which are not.

describe('mainLiftKey', () => {
  it.each([
    ['Squat', 'squat'], ['Back Squat', 'squat'], ['Low Bar Squat', 'squat'], ['Comp Squat', 'squat'],
    ['Bench Press', 'bench'], ['Comp Bench', 'bench'], ['Paused Bench', 'bench'],
    ['Deadlift', 'deadlift'], ['Sumo Deadlift', 'deadlift'], ['Conventional Deadlift', 'deadlift'],
  ])('%s is %s', (name, key) => {
    expect(mainLiftKey(name)).toBe(key)
  })

  it.each([
    'Romanian Deadlift', 'RDL', 'Stiff Leg Deadlift', 'Deficit Deadlift', 'Block Pull Deadlift',
    'Front Squat', 'Box Squat', 'Bulgarian Split Squat', 'Pin Squat', 'Goblet Squat',
    'Dumbbell Bench', 'Bench Pull', 'Sumo Squat', 'Leg Press', 'Barbell Row',
  ])('%s is not a competition lift', (name) => {
    expect(mainLiftKey(name)).toBeNull()
  })
})

// The e1RM and volume numbers count the competition lifts only (D43, D47).
describe('competitionLiftKey', () => {
  it.each([
    ['Squat', 'squat'], ['Back Squat', 'squat'], ['Competition Squat', 'squat'], ['Comp Squat', 'squat'], ['Knäböj', 'squat'],
    ['Bench', 'bench'], ['Bench Press', 'bench'], ['Competition Bench', 'bench'], ['Bänkpress', 'bench'],
    ['Deadlift', 'deadlift'], ['Sumo Deadlift', 'deadlift'], ['Conventional Deadlift', 'deadlift'], ['Marklyft', 'deadlift'],
    ['  squat ', 'squat'],
  ])('%s is %s', (name, key) => {
    expect(competitionLiftKey(name)).toBe(key)
  })

  it.each([
    'Pause Squat', 'Tempo Squat', 'Low Bar Squat', 'Front Squat', 'Paused Bench', 'Close Grip Bench',
    'Larsen Press', 'Romanian Deadlift', 'Deficit Deadlift', 'Pause Deadlift', 'Rows',
  ])('%s is a variation, not the competition lift', (name) => {
    expect(competitionLiftKey(name)).toBeNull()
  })
})

describe('bestStoredMax', () => {
  const max = (lift_name: string, weight: number, recorded_at: string) => ({ lift_name, weight, recorded_at })

  it('prefers the plain lift over a variation, whatever sorts first', () => {
    // "Banded Bench" sorts before "Bench Press" and used to win.
    const rows = [max('Banded Bench', 90, '2026-06-01'), max('Bench Press', 140, '2026-01-01')]
    expect(bestStoredMax('bench', rows)?.weight).toBe(140)
  })

  it('takes the most recent entry of the plain lift', () => {
    const rows = [max('Squat', 200, '2026-01-01'), max('Squat', 210, '2026-05-01'), max('Back Squat', 190, '2026-03-01')]
    expect(bestStoredMax('squat', rows)?.weight).toBe(210)
  })

  it('falls back to a variation when that is all there is', () => {
    expect(bestStoredMax('bench', [max('Paused Bench', 120, '2026-01-01')])?.weight).toBe(120)
  })

  it('never takes a Romanian deadlift as the deadlift max', () => {
    expect(bestStoredMax('deadlift', [max('Romanian Deadlift', 180, '2026-01-01')])).toBeNull()
  })
})
