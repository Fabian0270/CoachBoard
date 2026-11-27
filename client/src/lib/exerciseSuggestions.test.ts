import { describe, it, expect } from 'vitest'
import { matchSuggestions } from './exerciseSuggestions'

const builtIn = ['Squat', 'Front Squat', 'Pause Squat', 'Bench Press', 'Split Squat']

describe('matchSuggestions', () => {
  it("puts the coach's own names before the built-in list", () => {
    // Own names arrive most-used first, and keep that order.
    const own = ['SSB Squat', 'Comp Squat']
    expect(matchSuggestions(own, builtIn, 'squat')).toEqual([
      'SSB Squat', 'Comp Squat', 'Front Squat', 'Pause Squat', 'Split Squat',
    ])
  })

  it('ranks names that start with what was typed above names that contain it', () => {
    expect(matchSuggestions([], builtIn, 'sq')).toEqual(['Squat', 'Front Squat', 'Pause Squat', 'Split Squat'])
    expect(matchSuggestions(['Low bar squat', 'Squat (comp)'], [], 'squat')).toEqual(['Squat (comp)', 'Low bar squat'])
  })

  it("shows a name the coach also uses once, in the coach's spelling", () => {
    expect(matchSuggestions(['front squat'], builtIn, 'front')).toEqual(['front squat'])
  })

  it('leaves out a name that is exactly what was typed', () => {
    expect(matchSuggestions(['Squat'], builtIn, 'squat')).not.toContain('Squat')
  })

  it('suggests nothing for an empty field, and stops at the limit', () => {
    expect(matchSuggestions(['Squat'], builtIn, '  ')).toEqual([])
    expect(matchSuggestions([], builtIn, 's', 2)).toHaveLength(2)
  })
})
