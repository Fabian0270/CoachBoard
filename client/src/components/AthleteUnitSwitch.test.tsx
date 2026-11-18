// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderScreen, serve } from '../test/render'
import AthleteUnitSwitch from './AthleteUnitSwitch'

// S3 (D77): switching an athlete with numbers asks whether to convert them.

const athlete = { id: 'a1', name: 'Ada', unit: 'kg' }

const bodies = () =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === 'POST' && String(url).endsWith('/unit'))
    .map(([, init]) => JSON.parse(String(init?.body)))

describe('AthleteUnitSwitch', () => {
  it('asks before converting, and says what would change', async () => {
    let changed: unknown = null
    serve({
      '/api/athletes/a1/unit-impact': { body: { loadCaps: 12, loadsUsed: 3, maxes: 1, barPathSets: 0 } },
      'POST /api/athletes/a1/unit': { body: { ...athlete, unit: 'lb' } },
    })
    renderScreen(<AthleteUnitSwitch athlete={athlete} onChanged={(a) => { changed = a }} />)
    await userEvent.click(screen.getByRole('radio', { name: 'lb' }))
    expect(await screen.findByText('Convert their loads to lb?')).toBeTruthy()
    expect(screen.getByText(/12 Load Caps, 3 Loads Used, 1 max in kg/)).toBeTruthy()
    expect(screen.getByText(/rounded to the nearest 5 lb/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Convert to lb/ }))
    await waitFor(() => expect(bodies()).toEqual([{ unit: 'lb', convert: true }]))
    await waitFor(() => expect(changed).toMatchObject({ unit: 'lb' }))
  })

  it("“Don’t convert” only changes the unit", async () => {
    serve({
      '/api/athletes/a1/unit-impact': { body: { loadCaps: 1, loadsUsed: 0, maxes: 0, barPathSets: 0 } },
      'POST /api/athletes/a1/unit': { body: { ...athlete, unit: 'lb' } },
    })
    renderScreen(<AthleteUnitSwitch athlete={athlete} onChanged={() => {}} />)
    await userEvent.click(screen.getByRole('radio', { name: 'lb' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Don’t convert' }))
    await waitFor(() => expect(bodies()).toEqual([{ unit: 'lb', convert: false }]))
  })

  it('an athlete with no numbers switches without asking', async () => {
    serve({
      '/api/athletes/a1/unit-impact': { body: { loadCaps: 0, loadsUsed: 0, maxes: 0, barPathSets: 0 } },
      'POST /api/athletes/a1/unit': { body: { ...athlete, unit: 'lb' } },
    })
    renderScreen(<AthleteUnitSwitch athlete={athlete} onChanged={() => {}} />)
    await userEvent.click(screen.getByRole('radio', { name: 'lb' }))
    await waitFor(() => expect(bodies()).toEqual([{ unit: 'lb', convert: false }]))
    expect(screen.queryByText(/Convert their loads/)).toBeNull()
  })

  it('the current unit does nothing', async () => {
    serve({})
    renderScreen(<AthleteUnitSwitch athlete={athlete} onChanged={() => {}} />)
    await userEvent.click(screen.getByRole('radio', { name: 'kg' }))
    expect(bodies()).toEqual([])
  })
})
