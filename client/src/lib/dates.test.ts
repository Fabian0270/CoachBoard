import { describe, it, expect } from 'vitest'
import { localIsoDate, nextMonday, blockDates } from './dates'

describe('localIsoDate', () => {
  it('uses the local calendar, not UTC', () => {
    // 00:30 local on 16 Nov. In any zone east of UTC this is still 15 Nov in
    // UTC, which is what the old toISOString() version returned.
    expect(localIsoDate(new Date(2026, 10, 16, 0, 30))).toBe('2026-11-16')
  })
})

describe('nextMonday', () => {
  it('is today on a Monday, otherwise the coming Monday', () => {
    expect(nextMonday(new Date(2026, 10, 16, 9))).toBe('2026-11-16') // Monday
    expect(nextMonday(new Date(2026, 10, 17, 9))).toBe('2026-11-23') // Tuesday
    expect(nextMonday(new Date(2026, 10, 22, 23))).toBe('2026-11-23') // Sunday night
    expect(nextMonday(new Date(2026, 11, 29, 9))).toBe('2027-01-04') // across the year
  })
})

describe('blockDates', () => {
  it('starts on the Monday of the week and runs whole weeks', () => {
    expect(blockDates('2026-11-18', 4)).toEqual({ start: '2026-11-16', end: '2026-12-13' })
    expect(blockDates('2026-11-16', 1)).toEqual({ start: '2026-11-16', end: '2026-11-22' })
  })
})
