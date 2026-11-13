// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AthleteDetail from './AthleteDetail'
import { renderScreen, serve } from '../test/render'

const athlete = {
  id: 'a1', name: 'Maja Lind', sport: null, weight_class: null, height_cm: null,
  email: null, date_of_birth: null, notes: null,
}
const base = {
  '/api/athletes/a1': { body: athlete },
  '/api/programs': { body: [] },
  '/api/discord/settings': { body: { configured: false } },
}
const open = () => renderScreen(<AthleteDetail />, { path: '/athletes/a1?tab=programs', route: '/athletes/:id' })

describe('Athlete page', () => {
  it('says "not found" only when the athlete is really gone', async () => {
    serve({ ...base, '/api/athletes/a1': { status: 404, body: { error: 'Athlete not found' } } })
    open()
    expect(await screen.findByText(/Athlete not found/)).toBeTruthy()
  })

  it('treats a server error as a failed load, not as a deleted athlete', async () => {
    serve({ ...base, '/api/athletes/a1': { status: 500, body: { error: 'boom' } } })
    open()
    expect(await screen.findByText(/Could not load this athlete/)).toBeTruthy()
    expect(screen.queryByText(/not found/i)).toBeNull()
  })

  it('shows "No programs yet" only when there are none', async () => {
    serve(base)
    open()
    expect(await screen.findByText('No programs yet.')).toBeTruthy()
  })

  it('does not show a failed program list as an empty one, and recovers on retry', async () => {
    const server = serve({ ...base, '/api/programs': { status: 500, body: { error: 'boom' } } })
    open()

    expect(await screen.findByText(/Could not load this athlete's programs/)).toBeTruthy()
    expect(screen.queryByText('No programs yet.')).toBeNull()

    server.set('/api/programs', { body: [{ id: 'p1', name: 'Spring Block', status: 'active', start_date: null, focus: null }] })
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('Spring Block')).toBeTruthy()
  })
})
