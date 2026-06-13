import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { createApp } from './app.js'
import { initializeDatabase } from './db.js'

let server: Server
let baseUrl: string

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  return res
}
const json = async (path: string, init?: RequestInit) => {
  const res = await api(path, init)
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}
const post = (path: string, body: unknown) => json(path, { method: 'POST', body: JSON.stringify(body) })
const put = (path: string, body: unknown) => json(path, { method: 'PUT', body: JSON.stringify(body) })

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()))
}))

describe('athletes API', () => {
  it('creates an athlete from a form payload with empty optional fields', async () => {
    // Regression: empty strings used to fail validation with a 400.
    const { status, body } = await post('/api/athletes', {
      name: 'Form Athlete', email: '', sport: '', date_of_birth: '', notes: '',
    })
    expect(status).toBe(201)
    expect(body.email).toBeNull()
    expect(body.date_of_birth).toBeNull()
  })

  it('rejects an invalid email with 400', async () => {
    const { status } = await post('/api/athletes', { name: 'X', email: 'nope' })
    expect(status).toBe(400)
  })

  it('lists athletes', async () => {
    const { status, body } = await json('/api/athletes')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })

  it('returns 404 for a missing athlete', async () => {
    const { status } = await json('/api/athletes/00000000-0000-0000-0000-000000000000')
    expect(status).toBe(404)
  })
})

describe('athlete maxes API', () => {
  let athleteId: string

  beforeAll(async () => {
    const { body } = await post('/api/athletes', { name: 'Max Owner' })
    athleteId = body.id
  })

  it('creates a PR with kg as default unit', async () => {
    const { status, body } = await post(`/api/athletes/${athleteId}/maxes`, {
      lift_name: 'Squat', weight: 200, recorded_at: '2026-06-01',
    })
    expect(status).toBe(201)
    expect(body.unit).toBe('kg')
    expect(body.weight).toBe(200)
  })

  it('lists maxes newest-first per lift', async () => {
    await post(`/api/athletes/${athleteId}/maxes`, { lift_name: 'Squat', weight: 205, recorded_at: '2026-06-10' })
    const { status, body } = await json(`/api/athletes/${athleteId}/maxes`)
    expect(status).toBe(200)
    expect(body).toHaveLength(2)
    expect(body[0].weight).toBe(205) // latest squat first
  })

  it('rejects a non-positive weight', async () => {
    const { status } = await post(`/api/athletes/${athleteId}/maxes`, { lift_name: 'Bench Press', weight: 0 })
    expect(status).toBe(400)
  })

  it('returns 404 when the athlete does not exist', async () => {
    const { status } = await post('/api/athletes/00000000-0000-0000-0000-000000000000/maxes', {
      lift_name: 'Squat', weight: 100,
    })
    expect(status).toBe(404)
  })

  it('deletes a PR', async () => {
    const { body: created } = await post(`/api/athletes/${athleteId}/maxes`, { lift_name: 'Deadlift', weight: 240 })
    const res = await api(`/api/athletes/${athleteId}/maxes/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    const { body } = await json(`/api/athletes/${athleteId}/maxes`)
    expect(body.some((m: { id: string }) => m.id === created.id)).toBe(false)
  })

  it('cascades when the athlete is deleted', async () => {
    const { body: a } = await post('/api/athletes', { name: 'Cascade Max' })
    await post(`/api/athletes/${a.id}/maxes`, { lift_name: 'Squat', weight: 150 })
    await api(`/api/athletes/${a.id}`, { method: 'DELETE' })
    const { status } = await json(`/api/athletes/${a.id}/maxes`)
    expect(status).toBe(404)
  })
})

describe('programs API', () => {
  let athleteId: string
  let programId: string

  beforeAll(async () => {
    const { body } = await post('/api/athletes', { name: 'Program Owner' })
    athleteId = body.id
  })

  it('creates a program from a form payload with empty dates', async () => {
    // Regression: the NewProgram form always sends '' for unset dates.
    const { status, body } = await post('/api/programs', {
      athlete_id: athleteId, name: 'Block A', description: '', start_date: '', end_date: '', status: 'active',
    })
    expect(status).toBe(201)
    expect(body.start_date).toBeNull()
    programId = body.id
  })

  it('rejects end_date before start_date', async () => {
    const { status } = await post('/api/programs', {
      athlete_id: athleteId, name: 'Bad dates', start_date: '2026-02-01', end_date: '2026-01-01',
    })
    expect(status).toBe(400)
  })

  it('sets duration, normalizing start to Monday and returning parsed columns', async () => {
    await put(`/api/programs/${programId}`, { enabled_columns: ['rest_time', 'rpe'] })
    const { status, body } = await put(`/api/programs/${programId}/duration`, {
      start_date: '2026-06-13', weeks: 2,
    })
    expect(status).toBe(200)
    expect(body.start_date).toBe('2026-06-08')
    expect(body.end_date).toBe('2026-06-21')
    // Regression: this came back as a JSON string and crashed the column toggles.
    expect(body.enabled_columns).toEqual(['rest_time', 'rpe'])
  })

  it('creates workouts and exercises and nests them in GET', async () => {
    const w = await post(`/api/programs/${programId}/workouts`, { name: '2026-06-08', scheduled_date: '2026-06-08' })
    expect(w.status).toBe(201)
    const e = await post(`/api/programs/${programId}/workouts/${w.body.id}/exercises`, {
      name: 'Squat', sets: '3', reps: '5', order_index: 0,
    })
    expect(e.status).toBe(201)

    const { body } = await json(`/api/programs/${programId}`)
    expect(body.workouts).toHaveLength(1)
    expect(body.workouts[0].exercises[0].name).toBe('Squat')
  })

  it('exports the program as an Excel file', async () => {
    const res = await api(`/api/programs/${programId}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  it('refuses to export a program without a date range', async () => {
    const { body: p } = await post('/api/programs', { athlete_id: athleteId, name: 'No dates' })
    const res = await api(`/api/programs/${p.id}/export`)
    expect(res.status).toBe(400)
  })
})

describe('progress API', () => {
  let athleteId: string

  beforeAll(async () => {
    const { body } = await post('/api/athletes', { name: 'Progress Owner' })
    athleteId = body.id
  })

  it('logs a record with a date-only recorded_at (what the form sends)', async () => {
    // Regression: date-only values used to fail the datetime validation.
    const { status, body } = await post('/api/progress', {
      athlete_id: athleteId, metric_name: '100m', value: 11.2, unit: 's', recorded_at: '2026-06-13',
    })
    expect(status).toBe(201)
    expect(body.recorded_at).toBe('2026-06-13')
  })

  it('filters records by athlete', async () => {
    const { status, body } = await json(`/api/progress?athlete_id=${athleteId}`)
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].metric_name).toBe('100m')
  })

  it('rejects an invalid athlete_id filter', async () => {
    const { status } = await json('/api/progress?athlete_id=notauuid')
    expect(status).toBe(400)
  })
})

describe('API fallthrough', () => {
  it('returns JSON 404 for unknown API routes', async () => {
    const { status, body } = await json('/api/does-not-exist')
    expect(status).toBe(404)
    expect(body.error).toBe('Not found')
  })
})
