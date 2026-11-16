// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, screen, act } from '@testing-library/react'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// What the calendar cells show at a glance.

const ex = (id: string, workout_id: string, extra: Record<string, unknown>) => ({
  id, workout_id, name: 'Squat', sets: '5', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
})
const day = (id: string, date: string, exercises: unknown[]) => ({
  id, program_id: 'p1', name: date, scheduled_date: date, completed_at: null, notes: null, created_at: '', exercises,
})
// "Today" in these tests is Wednesday 17 June 2026.
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-28', created_at: '', updated_at: '',
  enabled_columns: null, focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [
    // Monday: trained and logged.
    day('w1', '2026-06-15', [ex('e1', 'w1', { intensity: 'RPE 8', load_used: '140', rpe: '8' })]),
    // Tuesday: past, nothing logged.
    day('w2', '2026-06-16', [ex('e2', 'w2', { name: 'Bench', intensity: '75%' })]),
    // Thursday: a long day.
    day('w4', '2026-06-18', ['A', 'B', 'C', 'D', 'E'].map((n, i) => ex(`e4${i}`, 'w4', { name: `Lift ${n}`, order_index: i }))),
  ],
}

const cell = (date: string) => document.querySelector<HTMLElement>(`[data-day="${date}"]`)!

const open = async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
  vi.setSystemTime(new Date(2026, 5, 17, 10))
  serve({ '/api/programs/p1': { body: program } })
  renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
  await screen.findByRole('heading', { name: 'Spring Block' })
}
afterEach(() => { vi.useRealTimers() })

describe('Program calendar — what a cell shows', () => {
  it('shows the intensity, so an RPE- or %-based program reads in the grid', async () => {
    await open()
    expect(cell('2026-06-15').textContent).toMatch(/Squat 5×5 · RPE 8/)
    expect(cell('2026-06-16').textContent).toMatch(/Bench 5×5 · 75%/)
  })

  it('marks a logged day, and a past training day with nothing logged', async () => {
    await open()
    expect(cell('2026-06-15').getAttribute('aria-label')).toMatch(/, logged/)
    expect(cell('2026-06-15').textContent).toMatch(/Logged/)
    expect(cell('2026-06-16').getAttribute('aria-label')).toMatch(/not logged yet/)
    // A future day is not "not logged".
    expect(cell('2026-06-18').getAttribute('aria-label')).not.toMatch(/logged/)
  })

  it('marks today', async () => {
    await open()
    expect(cell('2026-06-17').getAttribute('aria-label')).toMatch(/, today/)
    expect(cell('2026-06-16').getAttribute('aria-label')).not.toMatch(/today/)
  })

  it('puts the week’s first date beside its W label', async () => {
    await open()
    expect(screen.getByRole('button', { name: 'Week 2 actions' }).textContent).toMatch(/W2\s*22 Jun/)
  })

  it('shows the whole day when the pointer rests on a cell, and hides it on leaving', async () => {
    await open()
    expect(cell('2026-06-18').textContent).toMatch(/\+2 more/)
    fireEvent.mouseEnter(cell('2026-06-18'))
    await act(async () => { vi.advanceTimersByTime(500) })
    const tip = screen.getByRole('tooltip')
    for (const n of ['A', 'B', 'C', 'D', 'E']) expect(tip.textContent).toContain(`Lift ${n}`)
    fireEvent.mouseLeave(cell('2026-06-18'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
