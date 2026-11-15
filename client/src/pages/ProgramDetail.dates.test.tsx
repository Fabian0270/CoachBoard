// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// ---------------------------------------------------------------------------
// Changing a program's dates from its page.
// ---------------------------------------------------------------------------

const ex = (id: string, workout_id: string, extra = {}) => ({
  id, workout_id, name: 'Squat', sets: '5', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
})
const day = (id: string, date: string, extra = {}) => ({
  id, program_id: 'p1', name: date, scheduled_date: date, completed_at: null, notes: null, created_at: '',
  exercises: [ex(`e-${id}`, id, extra)],
})
// Two weeks, a session each Monday; week 2 has been trained.
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-28', created_at: '', updated_at: '',
  enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [day('w1', '2026-06-15'), day('w2', '2026-06-22', { load_used: '140', rpe: '8' })],
}

const durationBodies = () =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === 'PUT' && String(url).endsWith('/duration'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

const openDates = async () => {
  renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
  await userEvent.click(await screen.findByRole('button', { name: /Dates/ }))
  return screen.findByRole('dialog')
}

const setField = async (label: RegExp, value: string) => {
  const input = screen.getByLabelText(label) as HTMLInputElement
  await userEvent.clear(input)
  await userEvent.type(input, value)
}

describe('Program page — dates', () => {
  it('opens over the calendar instead of replacing it', async () => {
    serve({ '/api/programs/p1': { body: program } })
    await openDates()
    // The calendar is still there behind the dialog.
    expect(document.querySelector('[data-day="2026-06-15"]')).not.toBeNull()
  })

  it('says the training days move with a later start, and saves', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/duration': { body: { ...program, start_date: '2026-06-22', end_date: '2026-07-05' } },
    })
    const dialog = await openDates()
    await setField(/Start date/, '2026-06-22')
    expect(within(dialog).getByText(/Every training day moves 7 days later/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(durationBodies()).toEqual([{ start_date: '2026-06-22', weeks: 2, remove_outside: false }]),
    )
  })

  it('asks before a shorter program removes training days, naming those with results', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/duration': { body: program },
    })
    const dialog = await openDates()
    await setField(/Number of weeks/, '1')
    expect(within(dialog).getByRole('alert').textContent).toMatch(/1 training day would fall outside/)

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    const ask = await screen.findByRole('dialog', { name: /Remove 1 training day/ })
    expect(within(ask).getByText(/1 of them holds what the athlete logged/)).toBeTruthy()
    expect(durationBodies()).toHaveLength(0)

    await userEvent.click(within(ask).getByRole('button', { name: 'Remove and save' }))
    await waitFor(() =>
      expect(durationBodies()).toEqual([{ start_date: '2026-06-15', weeks: 1, remove_outside: true }]),
    )
  })

  it('changes nothing when the coach declines', async () => {
    serve({ '/api/programs/p1': { body: program } })
    const dialog = await openDates()
    await setField(/Number of weeks/, '1')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    const ask = await screen.findByRole('dialog', { name: /Remove 1 training day/ })
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(durationBodies()).toHaveLength(0)
  })
})
