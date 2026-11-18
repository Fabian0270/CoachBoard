// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Calculators from './Calculators'
import { renderScreen, serve } from '../test/render'

// S3 (D79): the calculators switch between kg and lb, starting on the default.

describe('Calculators in pounds', () => {
  it('start on the Settings default', async () => {
    serve({ '/api/settings/units': { body: { defaultUnit: 'lb' } } })
    renderScreen(<Calculators />)
    expect(await screen.findByText('Bodyweight (lb)')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'lb' }).getAttribute('aria-checked')).toBe('true')
  })

  it('score the same lifter the same in either unit', async () => {
    serve({ '/api/settings/units': { body: { defaultUnit: 'kg' } } })
    renderScreen(<Calculators />)
    await userEvent.type(await screen.findByPlaceholderText('e.g. 82.5'), '83')
    await userEvent.type(screen.getByPlaceholderText('e.g. 600'), '600')
    const dots = () => screen.getByText('DOTS').closest('div[class*="card"], div')!.parentElement!.textContent
    const inKg = dots()
    await userEvent.click(screen.getByRole('radio', { name: 'lb' }))
    const bw = screen.getByPlaceholderText('e.g. 182')
    const total = screen.getByPlaceholderText('e.g. 1320')
    await userEvent.clear(bw); await userEvent.type(bw, String(83 / 0.45359237))
    await userEvent.clear(total); await userEvent.type(total, String(600 / 0.45359237))
    await waitFor(() => expect(dots()).toBe(inKg))
  })

  it('warm up on a 45 lb bar with lb plates, rounded to 5 lb', async () => {
    serve({ '/api/settings/units': { body: { defaultUnit: 'lb' } } })
    renderScreen(<Calculators />)
    await userEvent.click(await screen.findByRole('tab', { name: /Warm-up/ }))
    expect(screen.getByDisplayValue('45')).toBeTruthy()
    await userEvent.type(screen.getByPlaceholderText('e.g. 440'), '405')
    const rows = [...document.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => / lb$/.test(r[2] ?? ''))).toBe(true)
    expect(rows.every((r) => Number((r[2] ?? '').replace(' lb', '')) % 5 === 0)).toBe(true)
    // The top single, 405 on a 45 lb bar: four 45s a side.
    expect(rows.at(-1)?.[4]).toBe('45 + 45 + 45 + 45')
  })
})
