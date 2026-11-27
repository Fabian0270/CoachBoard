// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderScreen, serve } from '../test/render'
import RevenueCard from './RevenueCard'

// S5 (D84–D86): revenue per month in each currency and in the coach's own.

const row = (month: string, byCurrency: Record<string, number>, totalHome: number | null) => ({ month, byCurrency, totalHome })
const summary = (basis: 'paid' | 'covered', over: Record<string, unknown> = {}) => ({
  home: 'SEK', basis,
  months: [row('2026-10', { EUR: 100 }, 1114.3), row('2026-11', { SEK: 1200 }, 1200)],
  later: row('later', basis === 'covered' ? { EUR: 50 } : {}, 557),
  outstanding: row('outstanding', { SEK: 1200 }, 1200),
  rates: { SEK: 1, EUR: 11.143 }, sources: { EUR: 'ecb' }, ecbDate: '2026-11-18', missingRates: [],
  ...over,
})
const urls = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.map(([u, i]) => `${i?.method ?? 'GET'} ${String(u)}`)

describe('RevenueCard', () => {
  // The switch is remembered per viewer; each test starts on the default.
  beforeEach(() => localStorage.clear())

  it('shows each month per currency and the total in the coach’s currency, newest first', async () => {
    serve({ '/api/payments/summary': (u) => ({ body: summary(u.searchParams.get('basis') === 'covered' ? 'covered' : 'paid') }) })
    renderScreen(<RevenueCard />)
    const table = await screen.findByRole('table', { name: 'Revenue per month' })
    const rows = within(table).getAllByRole('row').map((r) => r.textContent)
    expect(rows[0]).toContain('Total in SEK')
    expect(rows[1]).toMatch(/^Nov 2026/)
    expect(rows[2]).toMatch(/^Oct 2026/)
    expect(rows.at(-1)).toMatch(/^Not paid yet/)
    expect(screen.getByText(/European Central Bank’s rates of 2026-11-18/)).toBeTruthy()
    // The default counts in the month paid; no "Paid ahead" row.
    expect(within(table).queryByText('Paid ahead')).toBeNull()
  })

  it('the switch spreads payments over the months they cover', async () => {
    serve({ '/api/payments/summary': (u) => ({ body: summary(u.searchParams.get('basis') === 'covered' ? 'covered' : 'paid') }) })
    renderScreen(<RevenueCard />)
    await screen.findByRole('table', { name: 'Revenue per month' })
    await userEvent.click(screen.getByRole('radio', { name: 'Spread over months covered' }))
    expect(await screen.findByText('Paid ahead')).toBeTruthy()
    expect(urls()).toContain('GET /api/payments/summary?basis=covered')
  })

  it('asks for a rate the ECB has none of, and saves it', async () => {
    serve({
      '/api/payments/summary': { body: summary('paid', { months: [row('2026-11', { SEK: 1200, ISK: 5000 }, null)], sources: {}, missingRates: ['ISK'] }) },
      'PUT /api/payments/rates': { body: summary('paid') },
    })
    renderScreen(<RevenueCard />)
    expect(await screen.findByText(/No rate yet for ISK/)).toBeTruthy()
    await userEvent.type(screen.getByLabelText('SEK per ISK'), '0,08')
    await userEvent.click(screen.getByRole('button', { name: 'Save rates' }))
    await waitFor(() => expect(urls()).toContain('PUT /api/payments/rates?basis=paid'))
    const put = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.find(([u, i]) => i?.method === 'PUT' && String(u).includes('/rates'))!
    expect(JSON.parse(String(put[1]!.body))).toEqual({ rates: { ISK: 0.08 } })
  })
})
