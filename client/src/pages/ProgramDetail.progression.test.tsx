// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

const ex = (id: string, workout_id: string) => ({
  id, workout_id, name: 'Squat', sets: '5', reps: '5', weight: 100, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: 'RPE 7', load_used: null, rpe: null,
  group_id: null, suggestion_note: null,
})
// Week 1 copied to weeks 2 and 3: the same Monday squat each week.
const mondays = ['2026-06-15', '2026-06-22', '2026-06-29']
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-07-05', created_at: '', updated_at: '',
  enabled_columns: null, focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: mondays.map((d, i) => ({
    id: `w${i}`, program_id: 'p1', name: d, scheduled_date: d, completed_at: null, notes: null, created_at: '',
    exercises: [ex(`e${i}`, `w${i}`)],
  })),
}

const bodies = (method: string, suffix: string) =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === method && String(url).endsWith(suffix))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

describe('Program — progress an exercise', () => {
  it('previews the steps, applies them in one go, and offers Undo of those days', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/exercises': { body: { updated: 2 } },
      'PUT /api/programs/p1/days/restore': { body: program },
    })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(screen.getByRole('button', { name: /Progress/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Progress an exercise' })

    // Default step: 2.5 kg per week. Add half an RPE per week too.
    const rpe = within(dialog).getByLabelText('RPE per week')
    await userEvent.clear(rpe)
    await userEvent.type(rpe, '0.5')
    expect(dialog.textContent).toContain('102.5 kg · RPE 7.5')
    expect(dialog.textContent).toContain('105 kg · RPE 8')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2 rows' }))
    await waitFor(() => expect(bodies('PUT', '/exercises')).toEqual([{
      updates: [
        { id: 'e1', patch: { weight: 102.5, intensity: 'RPE 7.5' } },
        { id: 'e2', patch: { weight: 105, intensity: 'RPE 8' } },
      ],
    }]))
    expect(await screen.findByText('Squat progressed on 2 rows')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(bodies('PUT', '/days/restore')).toHaveLength(1))
    const restored = bodies('PUT', '/days/restore')[0] as { days: { date: string }[] }
    expect(restored.days.map((d) => d.date)).toEqual(['2026-06-22', '2026-06-29'])
  })

  it('a deload week is lighter, and the steps carry on after it', async () => {
    serve({ '/api/programs/p1': { body: program } })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(screen.getByRole('button', { name: /Progress/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Progress an exercise' })
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Week 2' }))
    // Week 2: 100 × 0.9 = 90. Week 3: one step on from week 1, 102.5.
    expect(dialog.textContent).toMatch(/W2 Mon · deload.*90 kg/)
    expect(dialog.textContent).toMatch(/W3 Mon.*102\.5 kg/)
  })
})
