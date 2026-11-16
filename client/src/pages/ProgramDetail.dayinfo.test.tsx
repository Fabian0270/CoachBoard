// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// Inside a day: what last week looked like, and the coach's own note.

const ex = (id: string, workout_id: string, extra: Record<string, unknown>) => ({
  id, workout_id, name: 'Squat', sets: '5', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
})
const day = (id: string, date: string, exercises: unknown[], notes: string | null = null) => ({
  id, program_id: 'p1', name: date, scheduled_date: date, completed_at: null, notes, created_at: '', exercises,
})
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-28', created_at: '', updated_at: '',
  enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [
    // Week 1 Monday: squat, trained.
    day('w1', '2026-06-15', [
      ex('a1', 'w1', { intensity: 'RPE 8', load_used: '140', rpe: '8' }),
      ex('a2', 'w1', { name: 'Rows', sets: '3', reps: '10' }),
    ]),
    // Week 2 Monday: the same lifts, to be progressed.
    day('w2', '2026-06-22', [
      ex('b1', 'w2', { intensity: 'RPE 8.5' }),
      ex('b2', 'w2', { name: 'Bench' }),
    ], 'Deload if knee flares'),
  ],
}

const putBodies = (suffix: string) =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === 'PUT' && String(url).endsWith(suffix))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

const openDay = async (date: string) => {
  renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
  await screen.findByRole('heading', { name: 'Spring Block' })
  await userEvent.click(document.querySelector<HTMLElement>(`[data-day="${date}"]`)!)
  await screen.findByRole('dialog')
}

describe('Day editor — last week', () => {
  it('shows what the same exercise was, and what was done, a week earlier', async () => {
    serve({ '/api/programs/p1': { body: program } })
    await openDay('2026-06-22')
    expect(screen.getByText('Last week: 5×5 · RPE 8 → did 140 @8')).toBeTruthy()
    // Bench was not done last week, so it gets no line.
    expect(screen.getAllByText(/^Last week:/)).toHaveLength(1)
  })

  it('shows nothing in the first week', async () => {
    serve({ '/api/programs/p1': { body: program } })
    await openDay('2026-06-15')
    expect(screen.queryByText(/^Last week:/)).toBeNull()
  })
})

describe('Day editor — suggested load', () => {
  const withLoadCap = { ...program, enabled_columns: ['intensity', 'load_cap'] }
  const maxes = [{ id: 'm1', athlete_id: 'a1', lift_name: 'Squat', weight: 180, unit: 'kg', recorded_at: '2026-06-01', notes: null }]

  it('offers a load from the max in the empty Load Cap, and fills it in only when taken', async () => {
    serve({
      '/api/programs/p1': { body: withLoadCap },
      '/api/athletes/a1/maxes': { body: maxes },
      'PUT /api/programs/p1/workouts/w2/exercises/b1': (_u, init) => ({ body: { ...withLoadCap.workouts[1].exercises[0], ...(JSON.parse(String(init?.body)) as object) } }),
    })
    await openDay('2026-06-22')
    // Squat 5×5 at RPE 8.5 from a 180 kg max.
    const cap = (await screen.findByPlaceholderText(/^≈ /)) as HTMLInputElement
    const kg = Number(cap.placeholder.replace('≈ ', ''))
    expect(kg).toBeGreaterThan(100)
    expect(cap.value).toBe('')
    expect(putBodies('/exercises/b1')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: /Use the suggested load/ }))
    await waitFor(() => expect(putBodies('/exercises/b1')).toEqual([{ weight: kg }]))
  })

  it('Ctrl+L takes it from anywhere in the row', async () => {
    serve({
      '/api/programs/p1': { body: withLoadCap },
      '/api/athletes/a1/maxes': { body: maxes },
      'PUT /api/programs/p1/workouts/w2/exercises/b1': (_u, init) => ({ body: { ...withLoadCap.workouts[1].exercises[0], ...(JSON.parse(String(init?.body)) as object) } }),
    })
    await openDay('2026-06-22')
    await screen.findByPlaceholderText(/^≈ /)
    // The cursor starts in the Squat row's name.
    await userEvent.keyboard('{Control>}l{/Control}')
    await waitFor(() => expect(putBodies('/exercises/b1')).toHaveLength(1))
    expect(typeof putBodies('/exercises/b1')[0].weight).toBe('number')
  })

  it('offers nothing for an exercise with no max on file', async () => {
    serve({ '/api/programs/p1': { body: withLoadCap }, '/api/athletes/a1/maxes': { body: maxes } })
    await openDay('2026-06-22')
    await screen.findByPlaceholderText(/^≈ /)
    // Squat has a hint; Bench (no target, no max) does not.
    expect(screen.getAllByPlaceholderText(/^≈ /)).toHaveLength(1)
  })
})

describe('Day editor — the day note', () => {
  it('shows the saved note and saves a change when leaving the field', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/workouts/w2': (_u, init) => ({ body: { ...program.workouts[1], ...(JSON.parse(String(init?.body)) as object) } }),
    })
    await openDay('2026-06-22')
    const note = screen.getByLabelText('Note for this day') as HTMLTextAreaElement
    expect(note.value).toBe('Deload if knee flares')
    await userEvent.clear(note)
    await userEvent.type(note, 'Belt from set 3')
    await userEvent.tab()
    await waitFor(() => expect(putBodies('/workouts/w2')).toEqual([{ notes: 'Belt from set 3' }]))
  })

  it('creates the day when a note is written on an empty one, and saves it when the day closes', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'POST /api/programs/p1/workouts': { status: 201, body: day('w9', '2026-06-17', []) },
      'PUT /api/programs/p1/workouts/w9': (_u, init) => ({ body: { ...day('w9', '2026-06-17', []), ...(JSON.parse(String(init?.body)) as object) } }),
    })
    await openDay('2026-06-17')
    await userEvent.type(screen.getByLabelText('Note for this day'), 'Rest — travel day')
    // Esc straight from the note: it must not be lost.
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(putBodies('/workouts/w9')).toEqual([{ notes: 'Rest — travel day' }]))
  })

  it('marks a day with a note in the calendar', async () => {
    serve({ '/api/programs/p1': { body: program } })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    expect(document.querySelector('[data-day="2026-06-22"] [aria-label="Has a note"]')).not.toBeNull()
    expect(document.querySelector('[data-day="2026-06-15"] [aria-label="Has a note"]')).toBeNull()
  })
})
