// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CompareAnalyses from './CompareAnalyses'
import { renderScreen, serve } from '../test/render'

// Compare: both paths on one plot, and "start both at rep N" (BP26).

// jsdom plays nothing: each video keeps its own clock.
const clocks = new WeakMap<HTMLMediaElement, number>()
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() { return clocks.get(this) ?? 0 },
    set(v: number) { clocks.set(this, v) },
  })
  HTMLMediaElement.prototype.pause = vi.fn()
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
})

const rep = (index: number, startT: number) => ({
  index, startT, endT: startT + 0.9, durationMs: 900, romPx: 200, meanVelocityPxS: 150, peakVelocityPxS: 200,
  romM: 0.75, meanVelocity: 0.55, peakVelocity: 0.74, meanPropulsiveVelocity: 0.6, propulsiveFraction: 0.9,
})
const set = (id: string, starts: number[], calibrated = true) => ({
  id, mediaId: null, athleteId: null, athleteName: id === 'a' ? 'Ann' : 'Bo', sourceLabel: `${id}.mp4`,
  track: Array.from({ length: 300 }, (_, i) => ({ t: i / 30, x: 300, y: 200 + 100 * Math.sin(i / 10) })),
  calibration: calibrated ? { a: { x: 0, y: 0 }, b: { x: 120, y: 0 }, plateDiameterMm: 450 } : null,
  metrics: starts.map((s, i) => rep(i, s)), notes: null, hasVideo: true,
  lift: 'back-squat', loadKg: 150, calledRpe: null, metric: null,
  createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:00:00Z',
})

const open = () => renderScreen(<CompareAnalyses />, { path: '/analysis/compare?left=a&right=b' })

describe('CompareAnalyses — both paths (BP26)', () => {
  it('lays both paths on one plot, and starts both videos at the top before rep 2', async () => {
    serve({
      '/api/analysis': { body: [] },
      '/api/analysis/a': { body: set('a', [1.8, 4.4, 7]) },
      '/api/analysis/b': { body: set('b', [0.9, 3.0]) },
    })
    open()
    expect(await screen.findByRole('img', { name: 'Both paths on one plot' })).toBeTruthy()
    // Only the reps both sets have.
    const select = screen.getByRole('combobox', { name: /Start both at/ })
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['—', 'rep 1', 'rep 2'])

    await userEvent.selectOptions(select, 'rep 2')
    const [left, right] = [...document.querySelectorAll('video')]
    expect(left.currentTime).toBeCloseTo(2.7) // the end of the left set's rep 1
    expect(right.currentTime).toBeCloseTo(1.8) // the end of the right set's rep 1
    expect(screen.getByText(/rep 2 picked out/)).toBeTruthy()
  })

  it('rep against rep in one set: each side from the bottom of its own rep (BP37)', async () => {
    serve({
      '/api/analysis': { body: [] },
      '/api/analysis/a': { body: set('a', [1.8, 4.4, 7]) },
    })
    renderScreen(<CompareAnalyses />, { path: '/analysis/compare?left=a&right=a&leftRep=0&rightRep=2' })
    expect(await screen.findByRole('img', { name: 'Both paths on one plot' })).toBeTruthy()
    const [left, right] = [...document.querySelectorAll('video')]
    for (const v of [left, right]) fireEvent(v, new Event('loadedmetadata'))
    expect(left.currentTime).toBeCloseTo(1.8) // the bottom of rep 1
    expect(right.currentTime).toBeCloseTo(7) // the bottom of rep 3
    expect(screen.getByText(/rep 1 on the left against rep 3 on the right/)).toBeTruthy()
  })

  it('without a scale on both, says why there is no shared plot', async () => {
    serve({
      '/api/analysis': { body: [] },
      '/api/analysis/a': { body: set('a', [1.8]) },
      '/api/analysis/b': { body: set('b', [0.9], false) },
    })
    open()
    expect(await screen.findByText(/once both sets have a scale/)).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Both paths on one plot' })).toBeNull()
  })
})
