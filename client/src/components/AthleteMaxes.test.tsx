// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
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
