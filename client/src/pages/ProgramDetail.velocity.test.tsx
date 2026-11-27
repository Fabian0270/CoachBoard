// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// The Velocity column (BP39, D71): off unless the coach switches it on, per program.

const squat = {
  id: 'e1', workout_id: 'w1', name: 'Squat', sets: '5', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  velocity: '0.50 · VL 20%', group_id: null, suggestion_note: null,
}
const base = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
  focus: null, export_layout: null, builtin_template: 'coachboard', bookmarked: 0, has_export_template: false,
  workouts: [{ id: 'w1', program_id: 'p1', name: 'Day 1', scheduled_date: '2026-06-15', completed_at: null, notes: null, created_at: '', exercises: [squat] }],
}

const calls = (method: string, ending: string) =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === method && String(url).endsWith(ending))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

const openDay = async () => {
  await userEvent.click(await screen.findByText('Squat'))
  return screen.findByRole('dialog')
}

describe('Velocity column', () => {
  it('is off for a program that never chose, though the target is stored', async () => {
    serve({ '/api/programs/p1': { body: { ...base, enabled_columns: null } } })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    const day = await openDay()
    expect(within(day).queryByText('Velocity')).toBeNull()
    expect(screen.queryByDisplayValue('0.50 · VL 20%')).toBeNull()
  })

  it('switched on in Columns, it shows and saves what the coach types', async () => {
    serve({
      '/api/programs/p1': { body: { ...base, enabled_columns: null } },
      'PUT /api/programs/p1': (_u, init) => ({ body: { ...base, ...(JSON.parse(String(init?.body)) as object) } }),
      'PUT /api/programs/p1/workouts/w1/exercises/e1': (_u, init) => ({ body: { ...squat, ...(JSON.parse(String(init?.body)) as object) } }),
    })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Columns' })
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Velocity \(target speed\)/ }))
    await waitFor(() => expect(calls('PUT', '/api/programs/p1')).toEqual([
      { enabled_columns: ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe', 'velocity'] },
    ]))
    await userEvent.keyboard('{Escape}')
    const day = await openDay()
    expect(within(day).getByText('Velocity')).toBeTruthy()
    const cell = screen.getByDisplayValue('0.50 · VL 20%')
    await userEvent.clear(cell)
    await userEvent.type(cell, '0.45-0.55')
    await userEvent.tab()
    await waitFor(() => expect(calls('PUT', '/exercises/e1')).toEqual([{ velocity: '0.45-0.55' }]))
  })
})
