// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderScreen, serve } from '../test/render'
import CurrencySettingsCard from './CurrencySettingsCard'

// Settings > Preferences: the coach's own currency, the one revenue is totalled in.

describe('CurrencySettingsCard', () => {
  it('shows the current currency and saves a new one', async () => {
    serve({ '/api/settings/currency': { body: { home: 'SEK' } }, 'PUT /api/settings/currency': (_u, i) => ({ body: JSON.parse(String(i?.body)) }) })
    renderScreen(<CurrencySettingsCard />)
    const select = (await screen.findByLabelText('Your currency')) as HTMLSelectElement
    expect(select.value).toBe('SEK')
    await userEvent.selectOptions(select, 'NOK')
    const put = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.find(([, i]) => i?.method === 'PUT')
    await waitFor(() => expect(JSON.parse(String(put()?.[1]?.body))).toEqual({ home: 'NOK' }))
    expect(await screen.findByText('Revenue is now totalled in NOK.')).toBeTruthy()
  })

  it('keeps a currency outside the list when it is the one set', async () => {
    serve({ '/api/settings/currency': { body: { home: 'XAF' } } })
    renderScreen(<CurrencySettingsCard />)
    expect(((await screen.findByLabelText('Your currency')) as HTMLSelectElement).value).toBe('XAF')
  })
})
