// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// P5 (D90): a generated exercise's note shows in a popover, from a marker or
// when its name cell is reached by keyboard — not in a hover tooltip.

const NOTE = 'Engine-suggested accessory (lockout strength) — edit or remove'
const ex = (id: string, extra: Record<string, unknown>) => ({
  id, workout_id: 'w1', name: 'Squat', sets: '3', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
})
const program = {
  id: 'p1', athlete_id: null, name: 'Draft Block', description: null, status: 'draft',
  start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
  enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard', bookmarked: 0, has_export_template: false,
  workouts: [{
    id: 'w1', program_id: 'p1', name: '2026-06-15', scheduled_date: '2026-06-15', completed_at: null, notes: null, created_at: '',
    exercises: [ex('e1', {}), ex('e2', { name: 'Board Press', order_index: 1, suggestion_note: NOTE })],
  }],
}

const openDay = async () => {
  serve({ '/api/programs/p1': { body: program } })
  renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
  await screen.findByRole('heading', { name: 'Draft Block' })
  await userEvent.click(document.querySelector<HTMLElement>('[data-day="2026-06-15"]')!)
  await screen.findByRole('dialog')
}

describe('Suggestion notes in the day editor', () => {
  it('only the suggested exercise has the marker, and it is not a tooltip any more', async () => {
    await openDay()
    expect(screen.getAllByRole('button', { name: 'Why this exercise' })).toHaveLength(1)
    expect(screen.getByDisplayValue('Board Press').getAttribute('title')).toBeNull()
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('clicking the marker shows the note', async () => {
    await openDay()
    await userEvent.click(screen.getByRole('button', { name: 'Why this exercise' }))
    expect(await screen.findByText(NOTE)).toBeTruthy()
  })

  it('the marker is not a Tab stop', async () => {
    await openDay()
    expect(screen.getByRole('button', { name: 'Why this exercise' }).getAttribute('tabindex')).toBe('-1')
  })
})
