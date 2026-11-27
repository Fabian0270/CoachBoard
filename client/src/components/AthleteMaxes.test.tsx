// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AthleteMaxes from './AthleteMaxes'
import { renderScreen, serve } from '../test/render'

// An estimated max is marked as one (BP34, D60).

describe('AthleteMaxes', () => {
  it('marks a max estimated from bar speed', async () => {
    serve({
      '/api/athletes/a1/maxes': { body: [
        { id: 'm2', athlete_id: 'a1', lift_name: 'Back squat', weight: 195, unit: 'kg', recorded_at: '2026-03-01', notes: null, estimated: 1 },
        { id: 'm1', athlete_id: 'a1', lift_name: 'Squat', weight: 180, unit: 'kg', recorded_at: '2026-01-10', notes: null, estimated: 0 },
      ] },
    })
    renderScreen(<AthleteMaxes athleteId="a1" />)
    expect(await screen.findByText('estimated')).toBeTruthy()
    expect(screen.getAllByText('estimated')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Back squat · 195 kg \(est\.\)/ })).toBeTruthy()
  })
})

// S3 (D76): a lb athlete's PRs and cheat sheet are in lb.
describe('AthleteMaxes in pounds', () => {
  it('logs the PR in lb and rounds the cheat sheet to 5 lb', async () => {
    let posted: Record<string, unknown> | null = null
    serve({
      '/api/athletes/a1/maxes': { body: [
        { id: 'm1', athlete_id: 'a1', lift_name: 'Squat', weight: 405, unit: 'lb', recorded_at: '2026-01-10', notes: null, estimated: 0 },
      ] },
      'POST /api/athletes/a1/maxes': (_u, init) => {
        posted = JSON.parse(String(init?.body))
        return { body: { id: 'm2', athlete_id: 'a1', lift_name: 'Bench', weight: 275, unit: 'lb', recorded_at: '2026-02-01', notes: null, estimated: 0 } }
      },
    })
    renderScreen(<AthleteMaxes athleteId="a1" unit="lb" />)
    expect(await screen.findByText(/rounded to 5 lb/)).toBeTruthy()
    expect(screen.getByLabelText('Weight (lb)')).toBeTruthy()
    // Every weight in the sheet is a whole number of 5 lb plates.
    const cells = [...document.querySelectorAll('tbody td.tabular-nums')].map((td) => td.textContent).filter((t) => t && t !== '—')
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every((t) => Number(t) % 5 === 0)).toBe(true)
    await userEvent.type(screen.getByLabelText('Lift'), 'Bench')
    await userEvent.type(screen.getByLabelText('Weight (lb)'), '275')
    await userEvent.click(screen.getByRole('button', { name: /Add PR/ }))
    await waitFor(() => expect(posted).toMatchObject({ lift_name: 'Bench', weight: 275, unit: 'lb' }))
  })

  it('a kg max kept after a switch still shows and rounds in kg', async () => {
    serve({
      '/api/athletes/a1/maxes': { body: [
        { id: 'm1', athlete_id: 'a1', lift_name: 'Squat', weight: 200, unit: 'kg', recorded_at: '2026-01-10', notes: null, estimated: 0 },
      ] },
    })
    renderScreen(<AthleteMaxes athleteId="a1" unit="lb" />)
    expect(await screen.findByText(/200 kg max \(Tuchscherer RPE chart, rounded to 2.5 kg\)/)).toBeTruthy()
  })
})