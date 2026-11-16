// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SavedAnalyses from './SavedAnalyses'
import { renderScreen, serve } from '../../test/render'

// The saved list: Show all, filters for athlete and lift (BP20), and the note (BP23).

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `a${i}`, mediaId: null, athleteId: i % 2 ? 'x1' : 'x2', athleteName: i % 2 ? 'Anna' : 'Erik', sourceLabel: '',
  track: [], calibration: null, metrics: [], notes: null, hasVideo: false,
  createdAt: `2026-11-${String(30 - i).padStart(2, '0')}T10:00:00Z`, updatedAt: '', lift: i % 3 ? 'back-squat' : 'bench-press',
  loadKg: 100 + i, calledRpe: null, metric: null, ...over,
})
const rows = Array.from({ length: 14 }, (_, i) => row(i, i === 0 ? { notes: 'Drive the hips through' } : {}))
const bodyRows = () => within(screen.getByRole('table', { name: 'Saved analyses' })).getAllByRole('row').slice(1)

describe('Saved analyses list', () => {
  it('shows the first ten, and all of them on request', async () => {
    serve({ '/api/analysis': { body: rows } })
    renderScreen(<SavedAnalyses limit={10} />)
    await screen.findByRole('table', { name: 'Saved analyses' })
    expect(bodyRows()).toHaveLength(10)
    await userEvent.click(screen.getByRole('button', { name: 'Show all 14' }))
    expect(bodyRows()).toHaveLength(14)
  })

  it('filters by athlete and by lift', async () => {
    serve({ '/api/analysis': { body: rows } })
    renderScreen(<SavedAnalyses limit={10} />)
    await screen.findByRole('table', { name: 'Saved analyses' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by athlete' }), 'x1')
    expect(bodyRows().every((r) => r.textContent?.includes('Anna'))).toBe(true)
    expect(bodyRows()).toHaveLength(7)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by lift' }), 'bench-press')
    // Anna (odd rows) and bench (rows divisible by 3): 3 and 9.
    expect(bodyRows().map((r) => r.textContent?.includes('103') || r.textContent?.includes('109'))).toEqual([true, true])
  })

  it("shows the coach's note", async () => {
    serve({ '/api/analysis': { body: rows } })
    renderScreen(<SavedAnalyses limit={10} />)
    expect(await screen.findByText('Drive the hips through')).toBeTruthy()
  })
})
