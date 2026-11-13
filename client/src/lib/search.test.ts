import { describe, it, expect } from 'vitest'
import { foldForSearch, matchesSearch } from './search'

describe('matchesSearch', () => {
  it('matches everything on a blank query', () => {
    expect(matchesSearch('', ['Maja Lind'])).toBe(true)
    expect(matchesSearch('   ', [null])).toBe(true)
  })

  it('ignores case and accents', () => {
    expect(foldForSearch('Åsa Öberg')).toBe('asa oberg')
    expect(matchesSearch('asa', ['Åsa Öberg'])).toBe(true)
    expect(matchesSearch('ÖBERG', ['Åsa Öberg'])).toBe(true)
  })

  it('needs every word, in any order and across fields', () => {
    expect(matchesSearch('squat lind', ['Spring Squat Block', 'Maja Lind'])).toBe(true)
    expect(matchesSearch('squat holm', ['Spring Squat Block', 'Maja Lind'])).toBe(false)
  })

  it('skips missing fields', () => {
    expect(matchesSearch('powerlifting', ['Maja Lind', null, undefined, 'Powerlifting'])).toBe(true)
  })
})
