// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AthleteMaxes from '../components/AthleteMaxes'
import PaymentsSection from '../components/PaymentsSection'
import ProgramComparison from './ProgramComparison'
import { renderScreen, serve } from '../test/render'

// ---------------------------------------------------------------------------
// A failure is not an empty list.
//
// The last places where a failed load turned into an empty state, and where a
// refused change did nothing on screen. The rule is the one lib/api.ts states:
// "nothing here" and "could not ask" must look different.
// ---------------------------------------------------------------------------

describe('A failed load is not shown as "nothing here"', () => {
  it("maxes: says they could not be loaded instead of \"No PRs yet\", and retries", async () => {
    const server = serve({ '/api/athletes/a1/maxes': { status: 500, body: { error: 'boom' } } })
    renderScreen(<AthleteMaxes athleteId="a1" />)
    expect(await screen.findByText(/Could not load this athlete's maxes/)).toBeTruthy()
    expect(screen.queryByText(/No PRs yet/)).toBeNull()

    server.set('/api/athletes/a1/maxes', { body: [] })
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText(/No PRs yet/)).toBeTruthy()
  })

  it('payments: says they could not be loaded instead of "No payments recorded yet"', async () => {
    serve({ '/api/payments': 'network-error' })
    renderScreen(<PaymentsSection athleteId="a1" />)
    expect(await screen.findByText(/Could not load this athlete's payments/)).toBeTruthy()
    expect(screen.queryByText(/No payments recorded yet/)).toBeNull()
  })
})

describe('A refused change says so', () => {
  const programs = [{ id: 'p1', name: 'Spring Block', status: 'active', athlete_id: 'a1', start_date: '2026-06-15', bookmarked: 0 }]

  it('Programs list: changing the status', async () => {
    serve({
      '/api/athletes': { body: [{ id: 'a1', name: 'Sara' }] },
      '/api/programs': { body: programs },
      'PUT /api/programs/p1': { status: 500, body: { error: 'boom' } },
    })
    renderScreen(<ProgramComparison />)
    await userEvent.click(await screen.findByRole('button', { name: 'Program options' }))
    await userEvent.click(screen.getByRole('button', { name: /completed/ }))
    expect(await screen.findByText(/Could not change the status/)).toBeTruthy()
  })

  it('Programs list: deleting keeps the program when the delete was refused', async () => {
    serve({
      '/api/athletes': { body: [{ id: 'a1', name: 'Sara' }] },
      '/api/programs': { body: programs },
      'DELETE /api/programs/p1': { status: 500, body: { error: 'boom' } },
    })
    renderScreen(<ProgramComparison />)
    await userEvent.click(await screen.findByRole('button', { name: 'Program options' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/Could not delete "Spring Block"/)).toBeTruthy()
    expect(screen.getByText('Spring Block')).toBeTruthy()
  })

  it('maxes: deleting a PR', async () => {
    serve({
      '/api/athletes/a1/maxes': { body: [{ id: 'm1', athlete_id: 'a1', lift_name: 'Squat', weight: 180, unit: 'kg', recorded_at: '2026-06-01', notes: null }] },
      'DELETE /api/athletes/a1/maxes/m1': { status: 500, body: { error: 'boom' } },
    })
    renderScreen(<AthleteMaxes athleteId="a1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Squat PR' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/Could not delete that PR/)).toBeTruthy()
    expect(screen.getAllByText('Squat').length).toBeGreaterThan(0)
  })
})
