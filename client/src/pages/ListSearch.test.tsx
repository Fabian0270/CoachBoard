// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AthletesList from './AthletesList'
import ProgramComparison from './ProgramComparison'
import { renderScreen, serve } from '../test/render'

const athletes = [
  { id: 'a1', name: 'Åsa Öberg', sport: 'Powerlifting', email: 'asa@example.com', archived: 0 },
  { id: 'a2', name: 'Maja Lind', sport: 'Weightlifting', email: null, archived: 0 },
  { id: 'a3', name: 'Erik Holm', sport: null, email: null, archived: 1 },
]

describe('Athletes search', () => {
  it('filters by name, ignoring accents, and finds archived athletes too', async () => {
    serve({ '/api/athletes': { body: athletes } })
    renderScreen(<AthletesList />)
    const search = await screen.findByRole('searchbox', { name: 'Search athletes' })

    await userEvent.type(search, 'asa')
    expect(screen.getByText('Åsa Öberg')).toBeTruthy()
    expect(screen.queryByText('Maja Lind')).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, 'holm')
    expect(screen.getByText('Erik Holm')).toBeTruthy() // archived, still found
  })

  it('says nothing matched rather than "No athletes yet"', async () => {
    serve({ '/api/athletes': { body: athletes } })
    renderScreen(<AthletesList />)
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search athletes' }), 'zzz')
    expect(screen.getByText(/No athletes match “zzz”/)).toBeTruthy()
    expect(screen.queryByText('No athletes yet')).toBeNull()
  })
})

describe('Programs search', () => {
  const programs = [
    { id: 'p1', name: 'Spring Squat Block', status: 'active', athlete_id: 'a1', start_date: null, focus: 'strength' },
    { id: 'p2', name: 'Meet Prep', status: 'active', athlete_id: 'a2', start_date: null, focus: 'peaking' },
  ]
  const routes = { '/api/athletes': { body: athletes }, '/api/programs': { body: programs } }

  it("finds a program by its name or its athlete's name", async () => {
    serve(routes)
    renderScreen(<ProgramComparison />)
    const search = await screen.findByRole('searchbox', { name: 'Search programs' })

    await userEvent.type(search, 'lind')
    expect(screen.getByText('Meet Prep')).toBeTruthy()
    expect(screen.queryByText('Spring Squat Block')).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, 'squat oberg')
    expect(screen.getByText('Spring Squat Block')).toBeTruthy()
    expect(screen.queryByText('Meet Prep')).toBeNull()
  })

  it('does not call programs that are only filtered out "No programs yet"', async () => {
    serve(routes)
    renderScreen(<ProgramComparison />)
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search programs' }), 'deadlift')
    expect(screen.getByText(/No programs match “deadlift” and the filters above/)).toBeTruthy()
    expect(screen.queryByText('No programs yet')).toBeNull()
  })

  it('still says "No programs yet" when there are none', async () => {
    serve({ ...routes, '/api/programs': { body: [] } })
    renderScreen(<ProgramComparison />)
    expect(await screen.findByText('No programs yet')).toBeTruthy()
  })
})
