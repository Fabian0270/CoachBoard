// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { hasUnsavedWork } from '../lib/unsavedWork'
import { renderScreen, serve } from '../test/render'

const squat = {
  id: 'e1', workout_id: 'w1', name: 'Squat', sets: '3', reps: '5', weight: null, duration: null,
  distance: null, notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null,
  rpe: null, group_id: null, suggestion_note: null,
}
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
  enabled_columns: null, focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [{ id: 'w1', program_id: 'p1', name: 'Day 1', scheduled_date: '2026-06-15', completed_at: null, notes: null, created_at: '', exercises: [squat] }],
}

const open = () => renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })

describe('Program page — loading', () => {
  it('shows the program once it loads', async () => {
    serve({ '/api/programs/p1': { body: program } })
    open()
    expect(await screen.findByRole('heading', { name: 'Spring Block' })).toBeTruthy()
  })

  it('says "not found" only for a program that is really gone', async () => {
    serve({ '/api/programs/p1': { status: 404, body: { error: 'Program not found' } } })
    open()
    expect(await screen.findByText(/Program not found/)).toBeTruthy()
  })

  it('treats a server error as a failed load to retry, not as a deleted program', async () => {
    const server = serve({ '/api/programs/p1': { status: 500, body: { error: 'boom' } } })
    open()
    expect(await screen.findByText(/Could not load this program/)).toBeTruthy()
    expect(screen.queryByText(/not found/i)).toBeNull()

    server.set('/api/programs/p1', { body: program })
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByRole('heading', { name: 'Spring Block' })).toBeTruthy()
  })

  it('does not sit on "Loading..." forever when the server cannot be reached', async () => {
    serve({ '/api/programs/p1': 'network-error' })
    open()
    expect(await screen.findByText(/could not reach its own server/)).toBeTruthy()
  })
})

describe('Program page — an edit that does not save', () => {
  it('keeps a banner up until the change is actually stored', async () => {
    const server = serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/workouts/w1/exercises/e1': { status: 500, body: { error: 'disk full' } },
    })
    open()

    // Open the day and change Sets, the way a coach would.
    await userEvent.click(await screen.findByText('Squat'))
    const sets = await screen.findByDisplayValue('3')
    fireEvent.change(sets, { target: { value: '4' } })
    fireEvent.blur(sets)

    expect(await screen.findByText(/1 change could not be saved/)).toBeTruthy()
    // Closing the window now would lose it, so the close guard is armed.
    expect(hasUnsavedWork()).toBe(true)

    // Close the day, as a coach would to reach the banner behind it.
    await userEvent.keyboard('{Escape}')
    server.set('PUT /api/programs/p1/workouts/w1/exercises/e1', { body: { ...squat, sets: '4' } })
    await userEvent.click(await screen.findByRole('button', { name: /Try again/ }))

    await waitFor(() => expect(screen.queryByText(/could not be saved/)).toBeNull())
    expect(hasUnsavedWork()).toBe(false)
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(2)
  })
})
