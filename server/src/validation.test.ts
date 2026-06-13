import { describe, it, expect } from 'vitest'
import { schemas } from './validation.js'

const ATHLETE_ID = '6f1f3a2e-9c1b-4f7d-8b3a-2d4e5f6a7b8c'

describe('athlete.create', () => {
  it('accepts a minimal valid athlete', () => {
    const r = schemas.athlete.create.safeParse({ name: 'Anna' })
    expect(r.success).toBe(true)
  })

  it('treats empty strings from HTML forms as null', () => {
    // This is exactly what the NewAthlete form sends for untouched fields.
    const r = schemas.athlete.create.safeParse({
      name: 'Anna', email: '', sport: '', date_of_birth: '', notes: '',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.email).toBeNull()
      expect(r.data.sport).toBeNull()
      expect(r.data.date_of_birth).toBeNull()
      expect(r.data.notes).toBeNull()
    }
  })

  it('rejects an invalid email', () => {
    expect(schemas.athlete.create.safeParse({ name: 'A', email: 'not-an-email' }).success).toBe(false)
  })

  it('accepts a valid email', () => {
    expect(schemas.athlete.create.safeParse({ name: 'A', email: 'a@b.se' }).success).toBe(true)
  })

  it('rejects an impossible date of birth', () => {
    expect(schemas.athlete.create.safeParse({ name: 'A', date_of_birth: '2024-13-99' }).success).toBe(false)
  })

  it('rejects a missing name', () => {
    expect(schemas.athlete.create.safeParse({}).success).toBe(false)
    expect(schemas.athlete.create.safeParse({ name: '' }).success).toBe(false)
  })
})

describe('program.create', () => {
  const base = { athlete_id: ATHLETE_ID, name: 'Off-season' }

  it('accepts empty-string dates from the form as null', () => {
    const r = schemas.program.create.safeParse({ ...base, description: '', start_date: '', end_date: '', status: 'active' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.start_date).toBeNull()
      expect(r.data.end_date).toBeNull()
      expect(r.data.description).toBeNull()
    }
  })

  it('rejects end_date before start_date', () => {
    const r = schemas.program.create.safeParse({ ...base, start_date: '2026-02-01', end_date: '2026-01-01' })
    expect(r.success).toBe(false)
  })

  it('accepts equal start and end dates', () => {
    expect(schemas.program.create.safeParse({ ...base, start_date: '2026-01-01', end_date: '2026-01-01' }).success).toBe(true)
  })

  it('rejects unknown enabled column names', () => {
    expect(schemas.program.create.safeParse({ ...base, enabled_columns: ['bogus'] }).success).toBe(false)
  })

  it('rejects a non-uuid athlete_id', () => {
    expect(schemas.program.create.safeParse({ athlete_id: '123', name: 'X' }).success).toBe(false)
  })

  it('rejects an unknown status', () => {
    expect(schemas.program.create.safeParse({ ...base, status: 'paused' }).success).toBe(false)
  })
})

describe('program.update', () => {
  it('also enforces the date range', () => {
    const r = schemas.program.update.safeParse({ start_date: '2026-02-01', end_date: '2026-01-01' })
    expect(r.success).toBe(false)
  })
})

describe('progress.create', () => {
  const base = { athlete_id: ATHLETE_ID, metric_name: '100m sprint', value: 11.2 }

  it('accepts a date-only recorded_at (what the date picker sends)', () => {
    expect(schemas.progress.create.safeParse({ ...base, recorded_at: '2026-06-13' }).success).toBe(true)
  })

  it('accepts a full ISO datetime recorded_at', () => {
    expect(schemas.progress.create.safeParse({ ...base, recorded_at: '2026-06-13T10:00:00.000Z' }).success).toBe(true)
  })

  it('treats an empty recorded_at as absent', () => {
    const r = schemas.progress.create.safeParse({ ...base, recorded_at: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.recorded_at).toBeUndefined()
  })

  it('rejects garbage recorded_at', () => {
    expect(schemas.progress.create.safeParse({ ...base, recorded_at: 'yesterday' }).success).toBe(false)
  })

  it('rejects a non-finite value', () => {
    expect(schemas.progress.create.safeParse({ ...base, value: Infinity }).success).toBe(false)
  })

  it('treats empty unit as null', () => {
    const r = schemas.progress.create.safeParse({ ...base, unit: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.unit).toBeNull()
  })
})

describe('exercise schemas', () => {
  it('normalizes empty optional strings to null', () => {
    const r = schemas.exercise.create.safeParse({ name: 'Squat', sets: '', reps: '', rest_time: '' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.sets).toBeNull()
      expect(r.data.reps).toBeNull()
      expect(r.data.rest_time).toBeNull()
    }
  })

  it('rejects negative weight', () => {
    expect(schemas.exercise.update.safeParse({ weight: -5 }).success).toBe(false)
  })
})
