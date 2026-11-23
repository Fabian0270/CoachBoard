import { describe, expect, it } from 'vitest'
import { pauseVerdict } from './RepTable'

// The bench pause check (BP32, D124): advice only, on the time the bar was motionless.

describe('pauseVerdict', () => {
  it('0.6 s or more looks good, any shorter pause is borderline, no pause is check', () => {
    expect(pauseVerdict(600).label).toBe('looks good')
    expect(pauseVerdict(1100).label).toBe('looks good')
    expect(pauseVerdict(599).label).toBe('borderline')
    expect(pauseVerdict(100).label).toBe('borderline')
    // Touch-and-go: the bar never stopped.
    expect(pauseVerdict(0).label).toBe('check')
    expect(pauseVerdict(33).label).toBe('check')
  })
})
