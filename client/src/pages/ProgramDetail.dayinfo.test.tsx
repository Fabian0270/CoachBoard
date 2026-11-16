// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
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
      'PUT /api/programs/p1/workouts/w2/exercises/b1': (_u, init) => ({ body: { ...(withLoadCap.workouts[1].exercises[0] as object), ...(JSON.parse(String(init?.body)) as object) } }),
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
      'PUT /api/programs/p1/workouts/w2/exercises/b1': (_u, init) => ({ body: { ...(withLoadCap.workouts[1].exercises[0] as object), ...(JSON.parse(String(init?.body)) as object) } }),
    })
    await openDay('2026-06-22')
    await screen.findByPlaceholderText(/^≈ /)
    // The cursor starts in the Squat row's name.
    await userEvent.keyboard('{Control>}l{/Control}')
    await waitFor(() => expect(putBodies('/exercises/b1')).toHaveLength(1))
    expect(typeof putBodies('/exercises/b1')[0].weight).toBe('number')
  })

  it('a back-off set ("-10%") is 10% under the set above it, not 10% of the max', async () => {
    // Top set at a fixed 150, then a back-off set; a second back-off under it
    // chains from the first's suggestion. Then Rows, whose "-10%" has no Rows
    // set above it and so gets nothing.
    const backoff = {
      ...withLoadCap,
      workouts: [day('w1', '2026-06-15', [
        ex('a1', 'w1', { sets: '1', reps: '3', intensity: 'RPE 8', weight: 150, group_id: 'g' }),
        ex('a2', 'w1', { sets: '3', reps: '5', intensity: '-10%', group_id: 'g', order_index: 1 }),
        ex('a3', 'w1', { sets: '2', reps: '5', intensity: '-10%', group_id: 'g', order_index: 2 }),
        ex('a4', 'w1', { name: 'Rows', sets: '3', reps: '10', intensity: '-10%', order_index: 3 }),
      ])],
    }
    serve({ '/api/programs/p1': { body: backoff }, '/api/athletes/a1/maxes': { body: maxes } })
    await openDay('2026-06-15')
    const hints = await screen.findAllByPlaceholderText(/^≈ /)
    expect(hints.map((el) => (el as HTMLInputElement).placeholder)).toEqual(['≈ 135', '≈ 122.5'])
    expect(hints[0].title).toBe('Suggested from 10% lighter than the set above (150 kg). Ctrl+L or "Use" fills it in.')
  })

  it('offers nothing for an exercise with no max on file', async () => {
    serve({ '/api/programs/p1': { body: withLoadCap }, '/api/athletes/a1/maxes': { body: maxes } })
    await openDay('2026-06-22')
    await screen.findByPlaceholderText(/^≈ /)
    // Squat has a hint; Bench (no target, no max) does not.
    expect(screen.getAllByPlaceholderText(/^≈ /)).toHaveLength(1)
  })
})

describe('Program — replace an exercise across the block', () => {
  const bodies = (suffix: string) =>
    (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
      .filter(([url, init]) => init?.method && init.method !== 'GET' && String(url).endsWith(suffix))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

  it('renames it on every day it is on, and offers Undo of those days', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'POST /api/programs/p1/rename-exercise': { body: { renamed: 2, dates: ['2026-06-15', '2026-06-22'] } },
      'PUT /api/programs/p1/days/restore': { body: program },
    })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(screen.getByRole('button', { name: /Replace/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Replace an exercise' })

    await userEvent.selectOptions(screen.getByLabelText('Replace'), 'Squat')
    await userEvent.type(screen.getByLabelText('With'), 'Pause Squat')
    expect(dialog.textContent).toMatch(/Changes 2 training days/)
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))

    await waitFor(() => expect(bodies('/rename-exercise')).toEqual([{ from: 'Squat', to: 'Pause Squat', from_date: null }]))
    expect(await screen.findByText('Squat → Pause Squat on 2 days')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(bodies('/days/restore')).toHaveLength(1))
    const restored = bodies('/days/restore')[0] as { days: { date: string }[] }
    expect(restored.days.map((d) => d.date)).toEqual(['2026-06-15', '2026-06-22'])
  })

  it('from a later week on, only changes the days from there', async () => {
    serve({ '/api/programs/p1': { body: program }, 'POST /api/programs/p1/rename-exercise': { body: { renamed: 1, dates: ['2026-06-22'] } } })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(screen.getByRole('button', { name: /Replace/ }))
    await screen.findByRole('dialog', { name: 'Replace an exercise' })
    await userEvent.selectOptions(screen.getByLabelText('Replace'), 'Squat')
    await userEvent.selectOptions(screen.getByLabelText('From'), '1')
    await userEvent.type(screen.getByLabelText('With'), 'Box Squat')
    expect(screen.getByText(/Changes 1 training day\./)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(bodies('/rename-exercise')).toEqual([{ from: 'Squat', to: 'Box Squat', from_date: '2026-06-22' }]))
  })
})

describe('Day editor — pasting rows from a spreadsheet', () => {
  const posts = (suffix: string) =>
    (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
      .filter(([url, init]) => init?.method === 'POST' && String(url).endsWith(suffix))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
  const paste = (el: Element, text: string) =>
    fireEvent.paste(el, { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } })

  it('fills the row from the cell pasted into, and adds the rest as new rows', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'POST /api/programs/p1/workouts/w2/exercises/paste': { status: 201, body: { exercises: [], newIds: [] } },
    })
    await openDay('2026-06-22')
    // Columns here: Exercise, Sets, Reps. Pasted into Squat's name.
    paste(screen.getByDisplayValue('Squat'), 'Back Squat\t4\t4\r\nLunge\t3\t10\r\n')
    await waitFor(() => expect(posts('/exercises/paste')).toHaveLength(1))
    expect(posts('/exercises/paste')[0]).toEqual({
      anchorId: 'b1',
      anchorPatch: { name: 'Back Squat', sets: '4', reps: '4' },
      rows: [{ name: 'Lunge', sets: '3', reps: '10' }],
    })
    expect(await screen.findByText('Pasted 2 rows')).toBeTruthy()
  })

  it('leaves ordinary text to the cell', async () => {
    serve({ '/api/programs/p1': { body: program } })
    await openDay('2026-06-22')
    paste(screen.getByDisplayValue('Squat'), 'Pause Squat')
    expect(posts('/exercises/paste')).toHaveLength(0)
  })

  it('creates the day when pasted into an empty one', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'POST /api/programs/p1/workouts': { status: 201, body: day('w9', '2026-06-17', []) },
      'POST /api/programs/p1/workouts/w9/exercises/paste': { status: 201, body: { exercises: [], newIds: [] } },
    })
    await openDay('2026-06-17')
    paste(screen.getByRole('button', { name: /Add exercise/ }), 'Squat\t5\t5\r\nBench\t5\t5\r\n')
    await waitFor(() => expect(posts('/w9/exercises/paste')).toHaveLength(1))
    expect(posts('/w9/exercises/paste')[0]).toEqual({
      anchorId: null, anchorPatch: null,
      rows: [{ name: 'Squat', sets: '5', reps: '5' }, { name: 'Bench', sets: '5', reps: '5' }],
    })
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
