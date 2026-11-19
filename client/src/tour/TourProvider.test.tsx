// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import TourProvider, { useTour } from './TourProvider'
import { TOUR_STOPS, words, type TourContext } from './stops'
import { renderScreen, serve } from '../test/render'

// T1, T4 (D14, D19, D21): the tour engine and the welcome.

const fresh = { welcomeAnswered: false, tourAt: null, tourFinished: false, checklist: { completed: [], skipped: [], done: false }, hasOwnData: false }

const server = (status: Record<string, unknown> = fresh) => serve({
  'GET /api/settings/tour': { body: status },
  'PUT /api/settings/tour': (_u, init) => ({ body: { ...status, ...JSON.parse(String(init?.body)) } }),
  'POST /api/sample': { body: { loaded: true, athleteId: 's1' } },
  '/api/programs': { body: [
    { id: 'p1', athlete_id: 's1', status: 'completed', start_date: '2026-10-19' },
    { id: 'p2', athlete_id: 's1', status: 'draft', start_date: '2026-11-23' },
  ] },
  '/api/discord/settings': { body: { configured: false } },
})

/** The dashboard, with the two things its stops point at. */
const app = () => renderScreen(
  <TourProvider>
    <Routes>
      <Route path="/" element={<div><nav data-tour="sidebar">nav</nav><section data-tour="dashboard-attention">attention</section></div>} />
      <Route path="*" element={<p>another page</p>} />
    </Routes>
  </TourProvider>,
  { path: '/' },
)

const card = () => screen.queryByRole('dialog', { name: /./ })
/** A stop's title as this setup shows it: the sample loaded, Discord not connected. */
const setup: TourContext = { sampleAthleteId: 's1', sampleAnalysisId: null, finishedProgramId: 'p1', firstDay: '2026-10-19', draftProgramId: 'p2', discordConnected: false }
const title = (i: number) => words(TOUR_STOPS[i].title, setup)

describe('the welcome', () => {
  it('first launch: offers the tour or looking around alone', async () => {
    const { calls } = server()
    app()
    expect(await screen.findByText('Welcome to CoachBoard')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Skip, I.ll look around myself/ }))
    await waitFor(() => expect(screen.queryByText('Welcome to CoachBoard')).toBeNull())
    expect(calls).toContain('PUT /api/settings/tour')
  })

  it('a coach with their own data is offered it once, as something new (D21)', async () => {
    server({ ...fresh, hasOwnData: true })
    app()
    expect(await screen.findByText('New: a guided tour')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
  })

  it('answered before: nothing is shown', async () => {
    server({ ...fresh, welcomeAnswered: true })
    app()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText('Welcome to CoachBoard')).toBeNull()
  })
})

describe('the tour', () => {
  it('loads the sample, walks the stops with the buttons and the arrows, and Esc pauses it', async () => {
    const { calls } = server()
    app()
    await userEvent.click(await screen.findByRole('button', { name: 'Take the tour' }))
    expect(await screen.findByText(title(0))).toBeTruthy()
    expect(calls).toContain('POST /api/sample')
    expect(screen.getByText(`1 of ${TOUR_STOPS.length}`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText(title(1))).toBeTruthy() // the sidebar
    await userEvent.keyboard('{ArrowRight}')
    expect(await screen.findByText(title(2))).toBeTruthy() // Ctrl+K, no target
    await userEvent.keyboard('{ArrowLeft}')
    expect(await screen.findByText(title(1))).toBeTruthy()
    // Where the coach is, kept so the tour can carry on later.
    expect(calls.filter((c) => c === 'PUT /api/settings/tour').length).toBeGreaterThan(2)

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText(title(1))).toBeNull())
    expect(screen.getByText(/Tour paused/)).toBeTruthy()
  })

  it('a stop whose target never appears is skipped, not left hanging', async () => {
    server({ ...fresh, welcomeAnswered: true })
    renderScreen(
      <TourProvider>
        <Starter />
        <Routes>
          {/* No sidebar on this page: the "sidebar" stop has nothing to point at. */}
          <Route path="/" element={<section data-tour="dashboard-attention">attention</section>} />
          <Route path="*" element={<p>another page</p>} />
        </Routes>
      </TourProvider>,
      { path: '/' },
    )
    await userEvent.click(await screen.findByRole('button', { name: 'start at the sidebar' }))
    // Five seconds of waiting for the sidebar, then on to the next stop.
    expect(await screen.findByText(title(2), {}, { timeout: 7000 })).toBeTruthy()
    expect(card()).toBeTruthy()
  }, 10_000)
})

function Starter() {
  const tour = useTour()
  return <button type="button" onClick={() => tour.start(1)}>start at the sidebar</button>
}
