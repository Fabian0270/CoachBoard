// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Dashboard from './Dashboard'
import { renderScreen, serve } from '../test/render'

// The dashboard's "needs attention" list (I2).

const items = [
  { kind: 'block-ending', athleteId: 'a1', athleteName: 'Anna', programId: 'p1', programName: 'Autumn Block', date: '2099-11-22', count: null },
  { kind: 'no-results', athleteId: 'a2', athleteName: 'Erik', programId: 'p2', programName: 'Strength', date: '2026-11-09', count: 2 },
  { kind: 'no-program', athleteId: 'a3', athleteName: 'Lisa', programId: null, programName: null, date: null, count: null },
  { kind: 'slow-session', athleteId: 'a1', athleteName: 'Anna', programId: null, programName: null, date: '2026-11-13', count: null, lift: 'back-squat', under: 0.094 },
]

const routes = (attention: unknown, discord = false) => ({
  '/api/athletes': { body: [] },
  '/api/programs': { body: [] },
  '/api/payments/alerts': { body: [] },
  '/api/style-profile': { body: null },
  '/api/discord/settings': { body: { configured: discord } },
  '/api/discord/media/counts': { body: { unmatched: 0, unreviewed: 3, unreadMessages: 0 } },
  '/api/dashboard/attention': attention as { body: unknown },
})

beforeEach(() => {
  // Past the first-start walkthrough.
  localStorage.setItem('coachboard.onboarding.v2', JSON.stringify({ completed: [], skipped: [], done: true }))
})

const card = async () => (await screen.findByRole('heading', { name: 'Needs attention' })).closest('section') as HTMLElement

describe('Dashboard — needs attention', () => {
  it('lists what to act on, each linking to where it is fixed', async () => {
    const server = serve(routes({ body: items }))
    renderScreen(<Dashboard />)
    const section = await card()
    const lines = within(section).getAllByRole('listitem').map((li) => li.textContent)
    expect(lines).toEqual([
      'Anna · Autumn Block ends Sun 22 Nov — no next block yet',
      'Erik · Strength: 2 training days with nothing logged (latest Mon 9 Nov)',
      'Lisa has no active program',
      'Anna’s back squat read 9 % under the usual on Fri 13 Nov — from the bar path sets that day',
    ])
    expect(within(section).getByRole('link', { name: 'Autumn Block' }).getAttribute('href')).toBe('/programs/p1')
    expect(within(section).getByRole('link', { name: 'Lisa' }).getAttribute('href')).toBe('/athletes/a3')
    // The coach's own date is sent, not the server's.
    expect(server.calls.find((c) => c.startsWith('GET /api/dashboard/attention'))).toMatch(/today=\d{4}-\d{2}-\d{2}$/)
  })

  it('adds the videos waiting in the inbox when Discord is set up', async () => {
    serve(routes({ body: [] }, true))
    renderScreen(<Dashboard />)
    expect(await screen.findByRole('link', { name: '3 videos to review' })).toBeTruthy()
  })

  it('says so when nothing needs the coach', async () => {
    serve(routes({ body: [] }))
    renderScreen(<Dashboard />)
    expect(within(await card()).getByText('Nothing needs your attention right now.')).toBeTruthy()
  })

  it('never says all is well when the check failed', async () => {
    const server = serve(routes({ status: 500, body: { error: 'Database locked' } }))
    renderScreen(<Dashboard />)
    expect(await screen.findByText(/Could not check what needs your attention/)).toBeTruthy()
    expect(screen.queryByText('Nothing needs your attention right now.')).toBeNull()
    server.set('/api/dashboard/attention', { body: items })
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('has no active program')).toBeTruthy()
  })

  it('shows the first eight and the rest on request', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...items[2], athleteId: `x${i}`, athleteName: `Athlete ${i}` }))
    serve(routes({ body: many }))
    renderScreen(<Dashboard />)
    const section = await card()
    expect(within(section).getAllByText('has no active program')).toHaveLength(8)
    await userEvent.click(within(section).getByRole('button', { name: 'Show all 11' }))
    expect(within(section).getAllByText('has no active program')).toHaveLength(11)
  })
})
