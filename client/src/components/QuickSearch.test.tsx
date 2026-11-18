// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import QuickSearch, { quickSearchHits } from './QuickSearch'
import ProgramDetail from '../pages/ProgramDetail'
import { renderScreen, serve } from '../test/render'

// P1 (D89): Ctrl+K from anywhere finds an athlete or a program and goes there.

const athletes = [
  { id: 'a1', name: 'Sara Lind', archived: 0 },
  { id: 'a2', name: 'Erik Berg', archived: 0 },
  { id: 'a3', name: 'Åsa Holm', archived: 1 },
]
const programs = [
  { id: 'p1', name: 'Spring Block', status: 'active', athlete_id: 'a1', start_date: '2026-03-01' },
  { id: 'p2', name: 'Peaking', status: 'completed', athlete_id: 'a1', start_date: '2026-01-01' },
  { id: 'p3', name: 'Base Template', status: 'active', athlete_id: null, start_date: '2026-02-01' },
]

describe('quickSearchHits', () => {
  it('with nothing typed: current athletes, then running programs, newest first', () => {
    const hits = quickSearchHits('', athletes, programs)
    expect(hits.map((h) => h.name)).toEqual(['Sara Lind', 'Erik Berg', 'Spring Block', 'Base Template'])
  })

  it('finds programs by their athlete, archived athletes too, and names starting with the query first', () => {
    expect(quickSearchHits('lind', athletes, programs).map((h) => h.name)).toEqual(['Sara Lind', 'Spring Block', 'Peaking'])
    expect(quickSearchHits('asa', athletes, programs)).toEqual([{ kind: 'athlete', id: 'a3', name: 'Åsa Holm', detail: 'Archived' }])
    expect(quickSearchHits('template', athletes, programs).map((h) => h.detail)).toEqual(['Template'])
    expect(quickSearchHits('b', athletes, programs).map((h) => h.name)).toEqual(['Erik Berg', 'Base Template', 'Spring Block'])
  })
})

const shell = (start: string) => {
  const server = serve({
    '/api/athletes': { body: athletes },
    '/api/programs': { body: programs },
  })
  renderScreen(
    <>
      <Routes>
        <Route path="/" element={<p>Home</p>} />
        <Route path="/athletes/:id" element={<p>Athlete page</p>} />
        <Route path="/programs/:id" element={<p>Program page</p>} />
      </Routes>
      <QuickSearch />
    </>,
    { path: start },
  )
  return server
}

describe('Ctrl+K', () => {
  it('opens, filters as you type, and Enter goes to the chosen one', async () => {
    shell('/')
    await userEvent.keyboard('{Control>}k{/Control}')
    const input = await screen.findByRole('combobox', { name: 'Find an athlete or program' })
    expect(document.activeElement).toBe(input)
    await screen.findByRole('option', { name: 'Sara Lind' })
    await userEvent.type(input, 'spring')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Spring BlockSara Lind'])
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText('Program page')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the arrows walk the list', async () => {
    shell('/')
    await userEvent.keyboard('{Control>}k{/Control}')
    await screen.findByRole('option', { name: 'Sara Lind' })
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(await screen.findByText('Athlete page')).toBeTruthy()
  })

  it('Ctrl+K again or Esc closes it', async () => {
    shell('/')
    await userEvent.keyboard('{Control>}k{/Control}')
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Control>}k{/Control}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await userEvent.keyboard('{Control>}k{/Control}')
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Ctrl+K while typing in a training day', () => {
  const ex = { id: 'e1', workout_id: 'w1', name: 'Squat', sets: '3', reps: '5', weight: null, duration: null, distance: null,
    notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null, group_id: null, suggestion_note: null }
  const program = {
    id: 'p1', athlete_id: null, name: 'Spring Block', description: null, status: 'active',
    start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
    enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard', bookmarked: 0, has_export_template: false,
    workouts: [{ id: 'w1', program_id: 'p1', name: '2026-06-15', scheduled_date: '2026-06-15', completed_at: null, notes: null, created_at: '', exercises: [ex] }],
  }

  it('saves what was typed before the search opens, and Esc puts the cursor back', async () => {
    const { calls } = serve({
      '/api/athletes': { body: athletes },
      '/api/programs': { body: programs },
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/workouts/w1/exercises/e1': { body: { ...ex, reps: '8' } },
    })
    renderScreen(
      <>
        <Routes><Route path="/programs/:id" element={<ProgramDetail />} /></Routes>
        <QuickSearch />
      </>,
      { path: '/programs/p1' },
    )
    await screen.findByRole('heading', { name: 'Spring Block' })
    await userEvent.click(document.querySelector<HTMLElement>('[data-day="2026-06-15"]')!)
    const reps = await screen.findByDisplayValue('5')
    await userEvent.clear(reps)
    await userEvent.type(reps, '8')
    await userEvent.keyboard('{Control>}k{/Control}')
    await screen.findByRole('combobox', { name: 'Find an athlete or program' })
    await waitFor(() => expect(calls).toContain('PUT /api/programs/p1/workouts/w1/exercises/e1'))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    // The day is still open, with the cursor back where it was.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByDisplayValue('8'))
  })
})
