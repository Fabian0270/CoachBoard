// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AthleteProgress from './AthleteProgress'
import { renderScreen, serve } from '../test/render'

// The athlete Progress tab (I1).

// jsdom has no ResizeObserver, which the charts' container needs; the app's
// Chromium does. The charts draw nothing at jsdom's zero size, which is fine:
// these tests read the words around them.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const point = (week: string, e1rm: number, programName = 'Autumn') => ({
  week, date: week, e1rm, weight: 150, reps: 3, rpe: 8, exerciseName: 'Squat', programId: 'p1', programName,
})
const progress = {
  e1rm: [
    { liftKey: 'squat', displayName: 'Squat', points: [point('2026-09-07', 165), point('2026-10-05', 172.5, 'Winter')] },
    { liftKey: 'bench', displayName: 'Bench', points: [point('2026-09-14', 110)] },
  ],
  prs: [
    { liftName: 'Back Squat', weight: 190, unit: 'kg', date: '2026-05-01', previous: 180 },
    { liftName: 'Squat', weight: 180, unit: 'kg', date: '2026-01-10', previous: null },
  ],
}
const rep = (mean: number) => ({ index: 0, startT: 0, endT: 1, durationMs: 800, romPx: 300, meanVelocityPxS: 1, peakVelocityPxS: 1, romM: 0.5, meanVelocity: mean, peakVelocity: mean + 0.3 })
const analysis = (createdAt: string, lift: string, loadKg: number, reps: number[]) => ({
  id: createdAt, mediaId: null, athleteId: 'a1', athleteName: 'Anna', sourceLabel: '', track: [], calibration: null,
  metrics: reps.map(rep), notes: null, hasVideo: false, createdAt, updatedAt: createdAt,
  lift, loadKg, calledRpe: 8, metric: null,
})

const render = () => renderScreen(<AthleteProgress athleteId="a1" />)

describe('Athlete Progress tab', () => {
  it('shows each lift across blocks, the PRs and the bar speed', async () => {
    serve({
      '/api/athletes/a1/progress': { body: progress },
      '/api/analysis': { body: [analysis('2026-09-08T10:00:00Z', 'back-squat', 150, [0.52, 0.48])] },
    })
    render()
    expect(await screen.findByText('Estimated 1RM across blocks')).toBeTruthy()
    expect(screen.getByText('Best 172.5 kg')).toBeTruthy()
    // British English writes September as "Sept" in newer ICU versions.
    expect(screen.getByText(/^\+7\.5 kg since 7 Sept? 26$/)).toBeTruthy()
    // One week of bench: said in words, with the program it came from.
    expect(screen.getByText(/One week so far: 110 kg/)).toBeTruthy()

    const prs = screen.getByRole('table', { name: 'PR timeline' })
    expect(within(prs).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['1 May 26', 'Back Squat', '190 kg', '+10 kg'],
      ['10 Jan 26', 'Squat', '180 kg', 'first'],
    ])

    // The fastest rep of the set, mean velocity for the squat.
    expect(await screen.findByText(/^One set so far: 0\.52 m\/s at 150 kg on 8 Sept? 26\.$/)).toBeTruthy()
  })

  it('lists velocity PRs from saved sets: faster than every earlier set at the same load (BP35)', async () => {
    serve({
      '/api/athletes/a1/progress': { body: progress },
      '/api/analysis': { body: [
        analysis('2026-09-08T10:00:00Z', 'back-squat', 150, [0.52]),
        analysis('2026-09-15T10:00:00Z', 'back-squat', 150, [0.58]),
        analysis('2026-09-22T10:00:00Z', 'back-squat', 160, [0.61]),
      ] },
    })
    render()
    const table = await screen.findByRole('table', { name: 'Velocity PRs' })
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      [expect.stringMatching(/^15 Sept? 26$/), 'Back squat 150 kg', '0.58 m/s', '+0.06 m/s'],
    ])
  })

  it('says what is missing rather than showing empty charts', async () => {
    serve({ '/api/athletes/a1/progress': { body: { e1rm: [], prs: [] } }, '/api/analysis': { body: [] } })
    render()
    expect(await screen.findByText(/Nothing logged on the competition lifts yet/)).toBeTruthy()
    expect(screen.getByText(/No maxes recorded yet/)).toBeTruthy()
    expect(await screen.findByText('No bar path sets saved with a lift yet.')).toBeTruthy()
  })

  it('a failed read says so, with a way to try again', async () => {
    const server = serve({ '/api/athletes/a1/progress': { status: 500, body: { error: 'Database locked' } }, '/api/analysis': { body: [] } })
    render()
    expect(await screen.findByText(/Could not load this athlete's progress/)).toBeTruthy()
    server.set('/api/athletes/a1/progress', { body: progress })
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('Best 172.5 kg')).toBeTruthy()
  })

  it('a failed bar speed read is not shown as no sets', async () => {
    serve({ '/api/athletes/a1/progress': { body: progress }, '/api/analysis': { status: 500, body: { error: 'Disk busy' } } })
    render()
    expect(await screen.findByText(/Could not read the saved bar path sets\./)).toBeTruthy()
    expect(screen.queryByText('No bar path sets saved with a lift yet.')).toBeNull()
  })
})
