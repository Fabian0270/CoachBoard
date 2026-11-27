// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderScreen, serve } from '../test/render'
import ReminderDialog from './ReminderDialog'

// S5 (D87): the coach reads and edits the reminder; it goes only on Send.

const draft = (over: Record<string, unknown> = {}) => ({
  body: {
    paymentId: 'p1', athleteName: 'Åsa Öberg', to: 'asa@example.com', status: 'overdue', remindedAt: null, emailConfigured: true,
    subject: 'Payment reminder — SEK 1,200.00 was due 15 November 2026',
    body: 'Hi Åsa,\n\nA friendly reminder…',
    ...over,
  },
})
const posts = () =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([, i]) => i?.method === 'POST').map(([u, i]) => [String(u), JSON.parse(String(i?.body))])

describe('ReminderDialog', () => {
  it('sends the edited text, and nothing before Send', async () => {
    let sent = false
    serve({ '/api/payments/p1/reminder': draft(), 'POST /api/payments/p1/reminder': () => { sent = true; return { body: { ok: true } } } })
    renderScreen(<ReminderDialog paymentId="p1" athleteId="a1" onClose={() => {}} onSent={() => {}} />)
    const message = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    expect(screen.getByText('asa@example.com')).toBeTruthy()
    expect(sent).toBe(false)
    await userEvent.clear(message)
    await userEvent.type(message, 'Hej Åsa — betalningen för november?')
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(posts()).toEqual([['/api/payments/p1/reminder', {
      subject: 'Payment reminder — SEK 1,200.00 was due 15 November 2026',
      body: 'Hej Åsa — betalningen för november?',
    }]]))
  })

  it('an athlete without an email: Send is off and the coach is pointed to their page', async () => {
    serve({ '/api/payments/p1/reminder': draft({ to: null }) })
    renderScreen(<ReminderDialog paymentId="p1" athleteId="a1" onClose={() => {}} onSent={() => {}} />)
    expect(await screen.findByText('no email address on file')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'their page' }).getAttribute('href')).toBe('/athletes/a1')
  })

  it('says when the last reminder went', async () => {
    serve({ '/api/payments/p1/reminder': draft({ remindedAt: '2026-11-10T09:00:00.000Z' }) })
    renderScreen(<ReminderDialog paymentId="p1" athleteId="a1" onClose={() => {}} onSent={() => {}} />)
    expect(await screen.findByText('Last reminder sent 2026-11-10.')).toBeTruthy()
  })
})
