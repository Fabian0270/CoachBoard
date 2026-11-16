// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import ProgramReport from './ProgramReport'
import { renderScreen, serve } from '../test/render'

// The Volume card in the program report (I3).

const ex = (id: string, extra: Record<string, unknown>) => ({
  id, workout_id: 'w', name: 'Squat', sets: '3', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
})
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-28', created_at: '', updated_at: '',
  enabled_columns: null, focus: null, export_layout: null, builtin_template: 'coachboard', bookmarked: 0, has_export_template: false,
  workouts: [
    { id: 'w1', program_id: 'p1', name: '', scheduled_date: '2026-06-15', completed_at: null, notes: null, created_at: '', exercises: [
      ex('a', { weight: 150, load_used: '150', rpe: '8' }),
      ex('c', { name: 'Squat', sets: '2', reps: '5', intensity: '-10%', order_index: 1 }),
      ex('b', { name: 'Pause Squat', sets: '2', reps: '3', weight: 100, order_index: 2 }),
    ] },
    { id: 'w2', program_id: 'p1', name: '', scheduled_date: '2026-06-22', completed_at: null, notes: null, created_at: '', exercises: [
      ex('d', { weight: 155 }),
      // Logged, but with no Load Cap and nothing to suggest one from.
      ex('e', { name: 'Pull-ups', sets: '3', reps: '8', load_used: '10', rpe: '8', order_index: 1 }),
    ] },
  ],
}
const report = {
  programId: 'p1', athleteId: 'a1', e1rmTrends: [], rpeDeviations: [], avgRpeDeviation: null,
  completionRate: 0.25, exercisesTotal: 4, exercisesCompleted: 1, storedMaxes: [],
}

describe('Program report — volume', () => {
  it('shows sets and tonnage per week, done / planned, with variations under Other', async () => {
    serve({ '/api/programs/p1/report': { body: report }, '/api/programs/p1': { body: program } })
    renderScreen(<ProgramReport />, { path: '/programs/p1/report', route: '/programs/:id/report' })
    const table = await screen.findByRole('table', { name: 'Volume per week' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Week', 'Squat', 'Other', 'Sets', 'Tonnage', 'Sets', 'Tonnage',
    ])
    const rows = within(table).getAllByRole('row').slice(2).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))
    expect(rows).toEqual([
      // Week 1: 3×5×150 done; the back-off is 2×5×135 (≈, 90% of the 150 above). Pause squat: 2×3×100.
      ['Wk 1', '3 / 5', '2,250 / ≈3,600', '0 / 2', '0 / 600'],
      // Pull-ups: done 3×8×10, but no planned load known — not "planned 0".
      ['Wk 2', '0 / 3', '0 / 2,325', '3 / 3', '240 / —'],
      ['Block', '3 / 8', '2,250 / ≈5,925', '3 / 5', '240 / 600'],
    ])
    expect(screen.getByText(/≈ includes suggested loads/)).toBeTruthy()
  })

  it('is there before any results are imported', async () => {
    const plain = { ...report, completionRate: 0, exercisesCompleted: 0 }
    serve({ '/api/programs/p1/report': { body: plain }, '/api/programs/p1': { body: program } })
    renderScreen(<ProgramReport />, { path: '/programs/p1/report', route: '/programs/:id/report' })
    expect(await screen.findByRole('table', { name: 'Volume per week' })).toBeTruthy()
    expect(screen.getByText('No results yet')).toBeTruthy()
  })
})
