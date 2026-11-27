import { describe, expect, it } from 'vitest'
import { pauseVerdict } from './RepTable'

// The bench pause check (BP32, D125): advice only.

describe('pauseVerdict', () => {
  it('0.6 s or more looks good, any shorter pause is borderline, no pause is check', () => {
    expect(pauseVerdict(600).label).toBe('looks good')
    expect(pauseVerdict(1500).label).toBe('looks good')
    expect(pauseVerdict(500).label).toBe('borderline')
    expect(pauseVerdict(200).label).toBe('borderline')
    // Touch-and-go: the bar never stopped — measured, the turn lasts a frame or two.
    expect(pauseVerdict(0).label).toBe('check')
    expect(pauseVerdict(67).label).toBe('check')
    expect(pauseVerdict(140).label).toBe('check')
  })

  it('is judged on the figure shown, to the tenth', () => {
    // 0.57 s is shown as 0.6 s: it must not read borderline beside it.
    expect(pauseVerdict(570).label).toBe('looks good')
    expect(pauseVerdict(540).label).toBe('borderline')
  })
})
