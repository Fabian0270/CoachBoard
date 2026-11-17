// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'
import SavedAnalysis from './SavedAnalysis'
import { renderScreen, serve } from '../test/render'
import { readSet } from '../components/analysis/readSet'

// A saved bar path set, reopened: it must read the same as when it was
// tracked (BP1–BP4), and say so when it cannot be loaded (BP6).

const rep = (index: number, mean: number, peak = mean * 1.4): RepMetrics => ({
  index, startT: index, endT: index + 0.8, durationMs: 800, romPx: 300, meanVelocityPxS: mean * 600, peakVelocityPxS: peak * 600,
  romM: 0.5, meanVelocity: mean, peakVelocity: peak, meanPropulsiveVelocity: mean * 1.1, propulsiveFraction: 0.9,
})
// Rep 3 is mistracked: its peak is more than 4× its mean (SUSPECT_PEAK_RATIO).
const metrics = [rep(0, 0.55), rep(1, 0.5), rep(2, 0.42, 1.9)]
const analysis = {
  id: 's1', mediaId: null, athleteId: 'a1', athleteName: 'Anna', sourceLabel: 'squat.mp4',
  track: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0, y: 10 }],
  calibration: { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, plateDiameterMm: 450 },
  metrics, notes: null, hasVideo: false, createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z',
  lift: 'back-squat', loadKg: 180, calledRpe: 8, metric: null,
}
// Another saved squat of Anna's, and her recorded max: the live page reads against both.
const other = { ...analysis, id: 's0', createdAt: '2026-11-01T10:00:00Z', loadKg: 160, calledRpe: 7, metrics: [rep(0, 0.7), rep(1, 0.62)] }
const maxes = [{ lift_name: 'Squat', weight: 220 }]

const routes = (extra: Record<string, unknown> = {}) => ({
  'GET /api/analysis/s1': { body: analysis },
  '/api/analysis': { body: [analysis, other] },
  '/api/athletes/a1/mvt': { body: {} },
  '/api/athletes/a1/maxes': { body: maxes },
  ...extra,
})
const open = () => renderScreen(<SavedAnalysis />, { path: '/analysis/saved/s1', route: '/analysis/saved/:id' })

describe('Saved bar path set', () => {
  it('shows the same rep table as the live page: every speed, the one read from marked, and ⚠', async () => {
    serve(routes() as never)
    open()
    const table = await screen.findByRole('table', { name: 'Reps' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Rep', 'Mean •', 'Propulsive', 'Peak', 'Range', 'Sideways', 'Down', 'Pause', 'Duration', '≈ RPE', 'Quality', 'Strike off',
    ])
    expect(within(table).getByLabelText('probably mistracked')).toBeTruthy()
  })

  it("estimates the max exactly as the live page does, against the athlete's other sets and max", async () => {
    serve(routes() as never)
    open()
    await screen.findByRole('table', { name: 'Reps' })
    // What the live page works out for this set with the same inputs.
    const live = readSet({
      reps: metrics, lift: 'back-squat', metric: 'mean', calibrated: true, loadKg: 180, calledRpe: 8,
      anchors: [{ rpe: 7, velocity: 0.62 }, { rpe: 8, velocity: 0.42 }], storedMvt: null,
      savedPoints: [{ load: 160, velocity: 0.7, label: '2026-11-01' }], maxes,
    })
    const want = `${Math.round(live.estimate!.e1rm * 2) / 2} kg`
    await waitFor(() => {
      const row = screen.getByText('Estimated 1RM').parentElement!
      expect(within(row).getByText(want)).toBeTruthy()
    })
  })

  it('strikes a rep off at once, and Undo puts it back', async () => {
    const patches: unknown[] = []
    const server = serve(routes({
      'PATCH /api/analysis/s1': (_u: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { metrics: RepMetrics[] }
        patches.push(body.metrics.map((m) => m.index))
        return { body: { ...analysis, metrics: body.metrics } }
      },
    }) as never)
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Strike off rep 3' }))
    await waitFor(() => expect(patches).toEqual([[0, 1]]))
    expect(within(screen.getByRole('table', { name: 'Reps' })).queryByText('3')).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches).toEqual([[0, 1], [0, 1, 2]]))
    expect(await screen.findByRole('button', { name: 'Strike off rep 3' })).toBeTruthy()
    void server
  })

  it('a failed load says so, with Retry — not that the analysis is gone', async () => {
    const server = serve(routes({ 'GET /api/analysis/s1': { status: 500, body: { error: 'locked' } } }) as never)
    open()
    expect(await screen.findByText(/Could not load this analysis/)).toBeTruthy()
    expect(screen.queryByText('That analysis no longer exists.')).toBeNull()
    server.set('GET /api/analysis/s1', { body: analysis })
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('table', { name: 'Reps' })).toBeTruthy()
  })

  it("shows the coach's note, and Edit set changes it (BP23)", async () => {
    const bodies: Record<string, unknown>[] = []
    serve(routes({
      'GET /api/analysis/s1': { body: { ...analysis, notes: 'Drive the hips through' } },
      'PATCH /api/analysis/s1': (_u: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        bodies.push(body)
        return { body: { ...analysis, notes: body.notes } }
      },
    }) as never)
    open()
    expect(await screen.findByText('Drive the hips through')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Edit set/ }))
    const box = screen.getByRole('textbox', { name: 'Note on this set' })
    await userEvent.clear(box)
    await userEvent.type(box, 'Keep the chest up')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Keep the chest up')).toBeTruthy()
    expect(bodies[0]).toMatchObject({ notes: 'Keep the chest up', lift: 'back-squat', loadKg: 180 })
  })

  // BP29 (D53) and BP35 (D54): the last set at exactly this load, and a velocity PR.
  it('offers the last set at the same load, and marks a velocity PR', async () => {
    const prev = { ...analysis, id: 's-1', createdAt: '2026-11-10T10:00:00Z', loadKg: 180, metrics: [rep(0, 0.5), rep(1, 0.48)] }
    serve(routes({ '/api/analysis': { body: [analysis, other, prev] } }) as never)
    open()
    const button = await screen.findByRole('button', { name: /Compare with last time/ })
    expect(button.getAttribute('title')).toContain('2026-11-10')
    // The mistracked rep 3 does not count; rep 1 at 0.55 beats 0.50.
    expect(await screen.findByText(/Velocity PR — fastest 180 kg back squat so far: 0\.55 m\/s \(was 0\.50\)/)).toBeTruthy()
  })

  it('no comparison when no earlier set was at exactly this load', async () => {
    serve(routes() as never)
    open()
    await screen.findByRole('table', { name: 'Reps' })
    expect(screen.queryByRole('button', { name: /Compare with last time/ })).toBeNull()
    expect(await screen.findByText(/The first 180 kg back squat tracked/)).toBeTruthy()
  })

  it('only a missing analysis says it no longer exists', async () => {
    serve(routes({ 'GET /api/analysis/s1': { status: 404, body: { error: 'Analysis not found' } } }) as never)
    open()
    expect(await screen.findByText('That analysis no longer exists.')).toBeTruthy()
  })
})
