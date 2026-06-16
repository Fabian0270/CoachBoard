import { describe, it, expect } from 'vitest'
import {
  toIsoDate,
  parseIsoDate,
  mondayOf,
  addDays,
  weeksBetween,
  dayName,
  exerciseValue,
  buildColumns,
  TOGGLEABLE_COLUMNS,
  type Exercise,
} from './programUtils'

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

describe('toIsoDate', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(toIsoDate(new Date(Date.UTC(2024, 0, 5)))).toBe('2024-01-05')
  })

  it('pads month and day with leading zeros', () => {
    expect(toIsoDate(new Date(Date.UTC(2024, 8, 3)))).toBe('2024-09-03')
  })
})

describe('parseIsoDate', () => {
  it('parses YYYY-MM-DD as UTC midnight', () => {
    const d = parseIsoDate('2024-03-15')
    expect(d.getUTCFullYear()).toBe(2024)
    expect(d.getUTCMonth()).toBe(2)
    expect(d.getUTCDate()).toBe(15)
    expect(d.getUTCHours()).toBe(0)
  })

  it('round-trips through toIsoDate', () => {
    const iso = '2025-12-31'
    expect(toIsoDate(parseIsoDate(iso))).toBe(iso)
  })
})

describe('mondayOf', () => {
  it('returns the same date when input is already Monday', () => {
    const monday = new Date(Date.UTC(2024, 0, 1)) // 2024-01-01 is a Monday
    expect(toIsoDate(mondayOf(monday))).toBe('2024-01-01')
  })

  it('returns the previous Monday for a Wednesday', () => {
    const wednesday = new Date(Date.UTC(2024, 0, 3)) // 2024-01-03 is a Wednesday
    expect(toIsoDate(mondayOf(wednesday))).toBe('2024-01-01')
  })

  it('returns the previous Monday for a Sunday', () => {
    const sunday = new Date(Date.UTC(2024, 0, 7)) // 2024-01-07 is a Sunday
    expect(toIsoDate(mondayOf(sunday))).toBe('2024-01-01')
  })

  it('handles first day of the year correctly', () => {
    const saturday = new Date(Date.UTC(2022, 0, 1)) // 2022-01-01 is a Saturday
    expect(toIsoDate(mondayOf(saturday))).toBe('2021-12-27')
  })
})

describe('addDays', () => {
  it('adds positive days', () => {
    const d = parseIsoDate('2024-01-01')
    expect(toIsoDate(addDays(d, 6))).toBe('2024-01-07')
  })

  it('adds zero days unchanged', () => {
    const d = parseIsoDate('2024-06-15')
    expect(toIsoDate(addDays(d, 0))).toBe('2024-06-15')
  })

  it('crosses month boundary', () => {
    const d = parseIsoDate('2024-01-30')
    expect(toIsoDate(addDays(d, 3))).toBe('2024-02-02')
  })
})

describe('weeksBetween', () => {
  it('returns 1 for exactly 7 days', () => {
    expect(weeksBetween('2024-01-01', '2024-01-07')).toBe(1)
  })

  it('returns 4 for 28 days', () => {
    expect(weeksBetween('2024-01-01', '2024-01-28')).toBe(4)
  })

  it('returns 1 minimum even for a same-day range', () => {
    expect(weeksBetween('2024-01-01', '2024-01-01')).toBe(1)
  })

  it('rounds up partial weeks', () => {
    expect(weeksBetween('2024-01-01', '2024-01-08')).toBe(2)
  })
})

describe('dayName', () => {
  it('returns Mon for a Monday', () => {
    expect(dayName('2024-01-01')).toBe('Mon')
  })

  it('returns Sun for a Sunday', () => {
    expect(dayName('2024-01-07')).toBe('Sun')
  })

  it('returns Wed for a Wednesday', () => {
    expect(dayName('2024-01-03')).toBe('Wed')
  })
})

// ---------------------------------------------------------------------------
// exerciseValue — exhaustiveness + field mapping
// ---------------------------------------------------------------------------

const baseExercise: Exercise = {
  id: 'e1',
  workout_id: 'w1',
  order_index: 0,
  name: 'Squat',
  sets: '3',
  reps: '8',
  weight: 100,
  duration: null,
  distance: null,
  notes: null,
  rest_time: '2',
  intensity: 'RPE 8',
  load_used: '95',
  rpe: '8',
  group_id: null,
}

describe('exerciseValue', () => {
  it('returns name', () => expect(exerciseValue(baseExercise, 'name')).toBe('Squat'))
  it('returns sets', () => expect(exerciseValue(baseExercise, 'sets')).toBe('3'))
  it('returns reps', () => expect(exerciseValue(baseExercise, 'reps')).toBe('8'))
  it('maps load_cap to weight', () => expect(exerciseValue(baseExercise, 'load_cap')).toBe('100'))
  it('returns rest_time', () => expect(exerciseValue(baseExercise, 'rest_time')).toBe('2'))
  it('returns intensity', () => expect(exerciseValue(baseExercise, 'intensity')).toBe('RPE 8'))
  it('returns load_used', () => expect(exerciseValue(baseExercise, 'load_used')).toBe('95'))
  it('returns rpe', () => expect(exerciseValue(baseExercise, 'rpe')).toBe('8'))

  it('returns empty string for null weight (load_cap)', () => {
    expect(exerciseValue({ ...baseExercise, weight: null }, 'load_cap')).toBe('')
  })

  it('returns empty string for null name', () => {
    expect(exerciseValue({ ...baseExercise, name: null as unknown as string }, 'name')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildColumns — column list varies with enabled set
// ---------------------------------------------------------------------------

describe('buildColumns', () => {
  it('always includes name, sets, reps', () => {
    const cols = buildColumns([])
    const keys = cols.map((c) => c.key)
    expect(keys).toContain('name')
    expect(keys).toContain('sets')
    expect(keys).toContain('reps')
  })

  it('excludes optional columns when not enabled', () => {
    const cols = buildColumns([])
    const keys = cols.map((c) => c.key)
    expect(keys).not.toContain('rest_time')
    expect(keys).not.toContain('intensity')
    expect(keys).not.toContain('load_cap')
    expect(keys).not.toContain('load_used')
    expect(keys).not.toContain('rpe')
  })

  it('includes all columns when all are enabled', () => {
    const cols = buildColumns(TOGGLEABLE_COLUMNS)
    const keys = cols.map((c) => c.key)
    for (const col of TOGGLEABLE_COLUMNS) {
      expect(keys).toContain(col)
    }
  })

  it('marks load_cap as numeric', () => {
    const cols = buildColumns(TOGGLEABLE_COLUMNS)
    const loadCap = cols.find((c) => c.key === 'load_cap')
    expect(loadCap?.numeric).toBe(true)
  })

  it('preserves column order: name, rest_time?, sets, reps, intensity?, ...', () => {
    const cols = buildColumns(TOGGLEABLE_COLUMNS)
    const keys = cols.map((c) => c.key)
    expect(keys.indexOf('name')).toBeLessThan(keys.indexOf('sets'))
    expect(keys.indexOf('sets')).toBeLessThan(keys.indexOf('reps'))
  })
})
