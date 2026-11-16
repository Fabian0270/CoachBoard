// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// The cue column: off unless the coach switches it on, per program.

const squat = {
  id: 'e1', workout_id: 'w1', name: 'Squat', sets: '5', reps: '5', weight: null, duration: null, distance: null,
  notes: 'pause 2 s', order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null,
}
const base = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
  focus: null, export_layout: null, builtin_template: 'coachboard', bookmarked: 0, has_export_template: false,
  workouts: [{ id: 'w1', program_id: 'p1', name: 'Day 1', scheduled_date: '2026-06-15', completed_at: null, notes: null, created_at: '', exercises: [squat] }],
}

const putBodies = () =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === 'PUT' && String(url).endsWith('/api/programs/p1'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

const openDay = async () => {
  await userEvent.click(await screen.findByText('Squat'))
  return screen.findByRole('dialog')
}

describe('Cue column', () => {
  it('is not there for a program that never chose its columns, though the cue is stored', async () => {
    serve({ '/api/programs/p1': { body: { ...base, enabled_columns: null } } })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    const day = await openDay()
    expect(within(day).queryByText('Notes')).toBeNull()
    expect(screen.queryByDisplayValue('pause 2 s')).toBeNull()
    // The columns it always had are all still there.
    for (const label of ['Rest (min)', 'Intensity/Weight', 'Load Cap', 'Load Used', 'Last Set RPE']) {
      expect(within(day).getByText(label)).toBeTruthy()
    }
  })

  it('switching it on in Columns adds it, and the cue written before shows again', async () => {
    serve({
      '/api/programs/p1': { body: { ...base, enabled_columns: null } },
      'PUT /api/programs/p1': (_u, init) => ({ body: { ...base, ...(JSON.parse(String(init?.body)) as object) } }),
    })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Columns' })
    const notes = within(dialog).getByRole('checkbox', { name: /Notes \(your cues\)/ }) as HTMLInputElement
    expect(notes.checked).toBe(false)
    await userEvent.click(notes)
    await waitFor(() => expect(putBodies()).toEqual([
      { enabled_columns: ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe', 'notes'] },
    ]))
    await userEvent.keyboard('{Escape}')
    const day = await openDay()
    expect(within(day).getByText('Notes')).toBeTruthy()
    expect(screen.getByDisplayValue('pause 2 s')).toBeTruthy()
  })

  it('switching it off hides it again and keeps the other columns as they were', async () => {
    serve({
      '/api/programs/p1': { body: { ...base, enabled_columns: ['intensity', 'rpe', 'notes'] } },
      'PUT /api/programs/p1': (_u, init) => ({ body: { ...base, ...(JSON.parse(String(init?.body)) as object) } }),
    })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Columns' })
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Notes \(your cues\)/ }))
    await waitFor(() => expect(putBodies()).toEqual([{ enabled_columns: ['intensity', 'rpe'] }]))
  })
})
