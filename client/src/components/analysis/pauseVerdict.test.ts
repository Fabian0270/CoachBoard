import { describe, expect, it } from 'vitest'
import { pauseVerdict } from './RepTable'

// The bench pause check (BP32, D64): advice only.

describe('pauseVerdict', () => {
  it('about a second looks good, half a second to a second is borderline, less is too short', () => {
    expect(pauseVerdict(1000).label).toBe('looks good')
    expect(pauseVerdict(1500).label).toBe('looks good')
    expect(pauseVerdict(999).label).toBe('borderline')
    expect(pauseVerdict(500).label).toBe('borderline')
    expect(pauseVerdict(499).label).toBe('check')
    expect(pauseVerdict(0).label).toBe('check')
  })
})
