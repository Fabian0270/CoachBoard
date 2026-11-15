// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { hasUnsavedWork } from '../lib/unsavedWork'
import { renderScreen, serve } from '../test/render'

const squat = {
  id: 'e1', workout_id: 'w1', name: 'Squat', sets: '3', reps: '5', weight: null, duration: null,
  distance: null, notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null,
  rpe: null, group_id: null, suggestion_note: null,
}
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
  enabled_columns: null, focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [{ id: 'w1', program_id: 'p1', name: 'Day 1', scheduled_date: '2026-06-15', completed_at: null, notes: null, created_at: '', exercises: [squat] }],
}

const open = () => renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })

describe('Program page — loading', () => {
  it('shows the program once it loads', async () => {
    serve({ '/api/programs/p1': { body: program } })
    open()
    expect(await screen.findByRole('heading', { name: 'Spring Block' })).toBeTruthy()
  })

  it('says "not found" only for a program that is really gone', async () => {
    serve({ '/api/programs/p1': { status: 404, body: { error: 'Program not found' } } })
    open()
    expect(await screen.findByText(/Program not found/)).toBeTruthy()
  })

  it('treats a server error as a failed load to retry, not as a deleted program', async () => {
    const server = serve({ '/api/programs/p1': { status: 500, body: { error: 'boom' } } })
    open()
    expect(await screen.findByText(/Could not load this program/)).toBeTruthy()
    expect(screen.queryByText(/not found/i)).toBeNull()

    server.set('/api/programs/p1', { body: program })
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByRole('heading', { name: 'Spring Block' })).toBeTruthy()
  })

  it('does not sit on "Loading..." forever when the server cannot be reached', async () => {
    serve({ '/api/programs/p1': 'network-error' })
    open()
    expect(await screen.findByText(/could not reach its own server/)).toBeTruthy()
  })
})

describe('Program page — an edit that does not save', () => {
  it('keeps a banner up until the change is actually stored', async () => {
    const server = serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/workouts/w1/exercises/e1': { status: 500, body: { error: 'disk full' } },
    })
    open()

    // Open the day and change Sets, the way a coach would.
    await userEvent.click(await screen.findByText('Squat'))
    const sets = await screen.findByDisplayValue('3')
    fireEvent.change(sets, { target: { value: '4' } })
    fireEvent.blur(sets)

    expect(await screen.findByText(/1 change could not be saved/)).toBeTruthy()
    // Closing the window now would lose it, so the close guard is armed.
    expect(hasUnsavedWork()).toBe(true)

    // Close the day, as a coach would to reach the banner behind it.
    await userEvent.keyboard('{Escape}')
    server.set('PUT /api/programs/p1/workouts/w1/exercises/e1', { body: { ...squat, sets: '4' } })
    await userEvent.click(await screen.findByRole('button', { name: /Try again/ }))

    await waitFor(() => expect(screen.queryByText(/could not be saved/)).toBeNull())
    expect(hasUnsavedWork()).toBe(false)
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(2)
  })
})

/** The body a PUT carried, read back from the recorded fetch call. */
const putBodies = (): Record<string, unknown>[] =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

describe('Day editor — what is typed is never lost', () => {
  it('saves the cell being typed in when Esc closes the day', async () => {
    // Reproduced in the 1.17.0 build: type 7 in Sets, press Esc without leaving
    // the cell, and the day closed with the server still holding 3. Cells saved
    // on blur only, and a focused element that unmounts never blurs.
    serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/workouts/w1/exercises/e1': (_url, init) => ({
        body: { ...squat, ...(JSON.parse(String(init?.body)) as object) },
      }),
    })
    open()
    await userEvent.click(await screen.findByText('Squat'))
    const sets = await screen.findByDisplayValue('3')
    await userEvent.clear(sets)
    await userEvent.type(sets, '7')
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(putBodies()).toContainEqual({ sets: '7' }))
  })

  it('does not let one save overwrite the cell being typed in next', async () => {
    // Reproduced in the 1.17.0 build with the Sets save slowed down: 9 typed in
    // Reps snapped back to 5 the moment the Sets save answered, and was never
    // sent. The row reset every draft whenever any saved field changed.
    let answerSets: (r: { body: unknown }) => void = () => {}
    serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1/workouts/w1/exercises/e1': (_url, init) => {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
        if ('sets' in patch) return new Promise((resolve) => { answerSets = resolve })
        return { body: { ...squat, sets: '4', ...patch } }
      },
    })
    open()
    await userEvent.click(await screen.findByText('Squat'))
    const sets = await screen.findByDisplayValue('3')
    await userEvent.clear(sets)
    await userEvent.type(sets, '4')

    // Click into Reps (this blurs Sets and starts its save) and type while that
    // save is still in flight.
    const reps = screen.getByDisplayValue('5')
    await userEvent.clear(reps)
    await userEvent.type(reps, '9')
    answerSets({ body: { ...squat, sets: '4' } })

    await waitFor(() => expect((sets as HTMLInputElement).value).toBe('4'))
    expect((reps as HTMLInputElement).value).toBe('9')
    await userEvent.tab()
    await waitFor(() => expect(putBodies()).toContainEqual({ reps: '9' }))
  })

  it('does not send a save for a row that was just deleted', async () => {
    // The flush-on-close must not fire for a row that is going away because the
    // coach deleted it: that save would 404 and raise a "could not be saved"
    // banner over something they removed on purpose.
    const server = serve({
      '/api/programs/p1': { body: program },
      'DELETE /api/programs/p1/workouts/w1/exercises/e1': { status: 204 },
    })
    open()
    await userEvent.click(await screen.findByText('Squat'))
    const sets = await screen.findByDisplayValue('3')
    await userEvent.clear(sets)
    await userEvent.type(sets, '7')
    fireEvent.click(screen.getByRole('button', { name: 'Delete exercise' }))

    await waitFor(() => expect(screen.queryByDisplayValue('7')).toBeNull())
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(0)
    expect(screen.queryByText(/could not be saved/)).toBeNull()
  })
})

describe('Day editor — the dialog', () => {
  const twoDays = {
    ...program,
    workouts: [
      program.workouts[0],
      { id: 'w2', program_id: 'p1', name: 'Day 2', scheduled_date: '2026-06-16', completed_at: null, notes: null, created_at: '',
        exercises: [{ ...squat, id: 'e2', workout_id: 'w2', name: 'Bench Press' }] },
    ],
  }

  it('titles the day by week and weekday, and starts with the cursor in the first cell', async () => {
    serve({ '/api/programs/p1': { body: twoDays } })
    open()
    await userEvent.click(await screen.findByText('Squat'))
    expect(await screen.findByRole('heading', { name: /Week 1 · Monday · /i })).toBeTruthy()
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('Squat')
  })

  it('pages to the next and previous calendar day with Page Down / Page Up', async () => {
    serve({ '/api/programs/p1': { body: twoDays } })
    open()
    await userEvent.click(await screen.findByText('Squat'))
    await screen.findByRole('heading', { name: /Monday/ })

    await userEvent.keyboard('{PageDown}')
    expect(await screen.findByRole('heading', { name: /Week 1 · Tuesday/ })).toBeTruthy()
    expect(await screen.findByDisplayValue('Bench Press')).toBeTruthy()

    // Wednesday is empty: paging goes to the next calendar day regardless.
    await userEvent.keyboard('{PageDown}')
    expect(await screen.findByRole('heading', { name: /Wednesday/ })).toBeTruthy()
    expect(screen.getByText(/No exercises yet/)).toBeTruthy()

    await userEvent.keyboard('{PageUp}{PageUp}')
    expect(await screen.findByRole('heading', { name: /Monday/ })).toBeTruthy()
    // Monday is the first day of the program: there is nothing before it.
    expect((screen.getByRole('button', { name: 'Previous day' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves the cell in hand when paging away from a day', async () => {
    serve({
      '/api/programs/p1': { body: twoDays },
      'PUT /api/programs/p1/workouts/w1/exercises/e1': (_url, init) => ({
        body: { ...squat, ...(JSON.parse(String(init?.body)) as object) },
      }),
    })
    open()
    await userEvent.click(await screen.findByText('Squat'))
    const sets = await screen.findByDisplayValue('3')
    await userEvent.clear(sets)
    await userEvent.type(sets, '6')
    await userEvent.keyboard('{PageDown}')
    await waitFor(() => expect(putBodies()).toContainEqual({ sets: '6' }))
  })

  it('returns to the day that was open when the dialog closes', async () => {
    serve({ '/api/programs/p1': { body: twoDays } })
    open()
    await userEvent.click(await screen.findByText('Squat'))
    await screen.findByRole('heading', { name: /Monday/ })
    await userEvent.keyboard('{PageDown}')
    await screen.findByRole('heading', { name: /Tuesday/ })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement?.getAttribute('data-day')).toBe('2026-06-16'))
  })
})
