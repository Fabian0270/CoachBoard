// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// ---------------------------------------------------------------------------
// The program calendar: moving around it by keyboard, the whole-day actions,
// and the Undo each of them offers.
// ---------------------------------------------------------------------------

const base = {
  weight: null, duration: null, distance: null, notes: null, rest_time: null, intensity: null,
  group_id: null, suggestion_note: null,
}
// Monday of week 1 has been trained: the athlete's results are on it.
const squat = { ...base, id: 'e1', workout_id: 'w1', name: 'Squat', sets: '5', reps: '5', load_used: '140', rpe: '8', order_index: 0 }
const rows = { ...base, id: 'e2', workout_id: 'w1', name: 'Rows', sets: '3', reps: '10', load_used: null, rpe: null, order_index: 1 }
// Tuesday of week 1 is planned but not trained.
const bench = { ...base, id: 'e3', workout_id: 'w2', name: 'Bench', sets: '4', reps: '6', load_used: null, rpe: null, order_index: 0 }

const MON1 = '2026-06-15'
const TUE1 = '2026-06-16'
const WED1 = '2026-06-17'
const MON2 = '2026-06-22'
const TUE2 = '2026-06-23'

const monday = { id: 'w1', program_id: 'p1', name: MON1, scheduled_date: MON1, completed_at: null, notes: null, created_at: 'c1', exercises: [squat, rows] }
const tuesday = { id: 'w2', program_id: 'p1', name: TUE1, scheduled_date: TUE1, completed_at: null, notes: null, created_at: 'c2', exercises: [bench] }
const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: MON1, end_date: '2026-06-28', created_at: '', updated_at: '',
  enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [monday, tuesday],
}

const day = (date: string) => document.querySelector<HTMLElement>(`[data-day="${date}"]`)!
const focusedDay = () => document.activeElement?.getAttribute('data-day')

/** Bodies sent with `method` to a path ending in `suffix`. */
const sent = (method: string, suffix: string): Record<string, unknown>[] =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => (init?.method ?? 'GET') === method && String(url).split('?')[0].endsWith(suffix))
    .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>)

const server = (extra: Parameters<typeof serve>[0] = {}) =>
  serve({
    '/api/programs/p1': { body: program },
    'POST /api/programs/p1/copy-day': { body: { copiedTo: 1 } },
    'POST /api/programs/p1/move-day': { body: { ok: true } },
    'PUT /api/programs/p1/days/restore': { body: program },
    'DELETE /api/programs/p1/workouts/w1': { status: 204 },
    'DELETE /api/programs/p1/workouts/w2': { status: 204 },
    ...extra,
  })

const open = async () => {
  renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
  await screen.findByRole('heading', { name: 'Spring Block' })
}

describe('Program calendar — keyboard', () => {
  it('moves between days with the arrow keys and opens one with Enter', async () => {
    server()
    await open()
    day(MON1).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedDay()).toBe(TUE1)
    await userEvent.keyboard('{ArrowDown}')
    expect(focusedDay()).toBe(TUE2)
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}')
    expect(focusedDay()).toBe(MON1)
    // The first day of the program: there is nowhere further to go.
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}')
    expect(focusedDay()).toBe(MON1)

    await userEvent.keyboard('{ArrowRight}{Enter}')
    expect(await screen.findByRole('heading', { name: /Week 1 · Tuesday/ })).toBeTruthy()
  })

  it('answers the arrow keys straight away, without a day being clicked first', async () => {
    server()
    await open()
    // Nothing has the focus, as when the page has just opened.
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)

    // The first press lands on the program's first day (the test block is in
    // the past, so "today" is not in it); the next one moves.
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedDay()).toBe(MON1)
    await userEvent.keyboard('{ArrowRight}')
    expect(focusedDay()).toBe(TUE1)
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: /Week 1 · Tuesday/ })).toBeTruthy()
  })

  it('leaves the arrow keys alone while something else has the focus', async () => {
    server()
    await open()
    const dates = screen.getByRole('button', { name: /Dates/ })
    dates.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(dates)
  })

  it('gives Tab one stop in the calendar instead of one per day', async () => {
    server()
    await open()
    const stops = [...document.querySelectorAll('[data-day]')].filter((el) => el.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
  })
})

describe('Program calendar — clearing a day', () => {
  it('clears a day with Delete and puts it back with Undo, ids and all', async () => {
    server()
    await open()
    day(TUE1).focus()
    await userEvent.keyboard('{Delete}')

    // No athlete results on Tuesday, so it does not ask first.
    await waitFor(() => expect(sent('DELETE', '/workouts/w2')).toHaveLength(1))
    expect(screen.queryByText('Bench')).toBeNull()

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(sent('PUT', '/days/restore')).toHaveLength(1))
    const [{ days }] = sent('PUT', '/days/restore') as unknown as [{ days: { date: string; workout: { id: string; exercises: { id: string }[] } }[] }]
    expect(days).toHaveLength(1)
    expect(days[0].date).toBe(TUE1)
    expect(days[0].workout.id).toBe('w2')
    expect(days[0].workout.exercises.map((e) => e.id)).toEqual(['e3'])
  })

  it('asks first when the day holds what the athlete logged', async () => {
    server()
    await open()
    day(MON1).focus()
    await userEvent.keyboard('{Delete}')

    const ask = await screen.findByRole('dialog')
    expect(within(ask).getByText(/Clear Mon W1\?/)).toBeTruthy()
    expect(within(ask).getByText(/what the athlete logged/)).toBeTruthy()
    expect(sent('DELETE', '/workouts/w1')).toHaveLength(0)

    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(sent('DELETE', '/workouts/w1')).toHaveLength(0)
    expect(screen.getByText('Squat')).toBeTruthy()
  })

  it('says so when the day could not be cleared, and leaves it in place', async () => {
    server({ 'DELETE /api/programs/p1/workouts/w2': { status: 500, body: { error: 'boom' } } })
    await open()
    day(TUE1).focus()
    await userEvent.keyboard('{Delete}')
    expect(await screen.findByText(/Could not finish clearing/)).toBeTruthy()
  })
})

describe('Program calendar — copy, cut and paste a day', () => {
  it('pastes a copied day onto an empty one, and Undo empties it again', async () => {
    server()
    await open()
    day(TUE1).focus()
    await userEvent.keyboard('{Control>}c{/Control}')
    expect(day(TUE1).getAttribute('aria-label')).toMatch(/copied/)

    await userEvent.keyboard('{ArrowRight}{Control>}v{/Control}')
    await waitFor(() => expect(sent('POST', '/copy-day')).toEqual([{ sourceDate: TUE1, targetDates: [WED1] }]))

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(sent('PUT', '/days/restore')).toEqual([{ days: [{ date: WED1, workout: null }] }]))
  })

  it('asks before pasting over a day that holds athlete results', async () => {
    server()
    await open()
    day(TUE1).focus()
    await userEvent.keyboard('{Control>}c{/Control}{ArrowLeft}{Control>}v{/Control}')

    const ask = await screen.findByRole('dialog')
    expect(within(ask).getByText(/Replace Mon W1\?/)).toBeTruthy()
    expect(sent('POST', '/copy-day')).toHaveLength(0)
    await userEvent.click(within(ask).getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(sent('POST', '/copy-day')).toEqual([{ sourceDate: TUE1, targetDates: [MON1] }]))
  })

  it('moves a cut day, replacing what is on the target', async () => {
    server()
    await open()
    day(TUE1).focus()
    await userEvent.keyboard('{Control>}x{/Control}{ArrowRight}{Control>}v{/Control}')
    await waitFor(() =>
      expect(sent('POST', '/move-day')).toEqual([{ sourceDate: TUE1, targetDate: WED1, replace: true }]),
    )
    // Undo puts both days back as they were.
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(sent('PUT', '/days/restore')).toHaveLength(1))
    const [{ days }] = sent('PUT', '/days/restore') as unknown as [{ days: { date: string; workout: { id: string } | null }[] }]
    expect(days.map((d) => [d.date, d.workout?.id ?? null])).toEqual([[TUE1, 'w2'], [WED1, null]])
  })

  it('says so when a move is refused', async () => {
    server({ 'POST /api/programs/p1/move-day': { status: 400, body: { error: 'No workout on source date' } } })
    await open()
    day(TUE1).focus()
    await userEvent.keyboard('{Control>}x{/Control}{ArrowRight}{Control>}v{/Control}')
    expect(await screen.findByText(/No workout on source date/)).toBeTruthy()
  })
})

describe('Day editor — copying a day to others', () => {
  const openTuesdayCopyPanel = async () => {
    await open()
    await userEvent.click(day(TUE1))
    await userEvent.click(await screen.findByRole('button', { name: /Copy to…/ }))
  }

  it('reaches any day of the program, not only the same weekday', async () => {
    server()
    await openTuesdayCopyPanel()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Week 2 Wed' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy to 1 day' }))
    await waitFor(() => expect(sent('POST', '/copy-day')).toEqual([{ sourceDate: TUE1, targetDates: ['2026-06-24'] }]))
  })

  it('leaves a day with athlete results unticked, and warns when it is ticked on purpose', async () => {
    server()
    // Copy Monday-with-results' neighbour onto every Tuesday… and look at Monday.
    await openTuesdayCopyPanel()
    const mondayW1 = screen.getByRole('checkbox', { name: 'Week 1 Mon, has athlete results' }) as HTMLInputElement
    expect(mondayW1.checked).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()

    await userEvent.click(mondayW1)
    expect(screen.getByRole('alert').textContent).toMatch(/Week 1 Mon holds what the athlete logged/)
  })

  it('"Same day, all weeks" skips a week that holds athlete results', async () => {
    // Monday week 2 gets results; copying Monday week 1 to all weeks must skip it.
    const trained = { ...monday, id: 'w9', scheduled_date: MON2, name: MON2, exercises: [{ ...squat, id: 'e9', workout_id: 'w9' }] }
    server({ '/api/programs/p1': { body: { ...program, end_date: '2026-07-05', workouts: [monday, tuesday, trained] } } })
    await open()
    await userEvent.click(day(MON1))
    await userEvent.click(await screen.findByRole('button', { name: /Copy to…/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Same day, all weeks' }))

    expect((screen.getByRole('checkbox', { name: 'Week 2 Mon, has athlete results' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: 'Week 3 Mon' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Copy to 1 day' })).toBeTruthy()
  })
})

describe('Program calendar — a whole week', () => {
  it('copies a week to another, rest days included', async () => {
    server()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Week 1 actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Copy week to/ }))
    await userEvent.click(await screen.findByRole('checkbox', { name: /Week 2/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy to 1 week' }))

    await waitFor(() => expect(sent('POST', '/copy-day')).toHaveLength(2))
    expect(sent('POST', '/copy-day')).toEqual([
      { sourceDate: MON1, targetDates: [MON2] },
      { sourceDate: TUE1, targetDates: [TUE2] },
    ])
    expect(await screen.findByText(/Week 1 copied to week 2/)).toBeTruthy()
  })
})

describe('Day editor — deleting an exercise can be undone', () => {
  const restoreRoute = {
    'DELETE /api/programs/p1/workouts/w2/exercises/e3': { status: 204 as const },
    'POST /api/programs/p1/workouts/w2/exercises/restore': { body: { exercises: [bench] } },
  }

  it('offers Undo, which puts the row back with its id', async () => {
    server(restoreRoute)
    await open()
    await userEvent.click(day(TUE1))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete exercise' }))
    expect(await screen.findByText('Bench deleted')).toBeTruthy()

    // The toast is outside the open dialog, which hides everything else from
    // assistive technology — hence hidden: true. It is still clickable: its
    // own pointer-events class overrides the one the dialog puts on <body>,
    // which this stylesheet-less environment cannot know (checked in the
    // packaged build instead).
    await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole('button', { name: 'Undo', hidden: true }))
    await waitFor(() => expect(sent('POST', '/exercises/restore')).toHaveLength(1))
    const [{ exercises }] = sent('POST', '/exercises/restore') as unknown as [{ exercises: { id: string; name: string }[] }]
    expect(exercises.map((e) => `${e.id}:${e.name}`)).toEqual(['e3:Bench'])
    // The day is still open: pressing Undo in the toast is not a click outside it.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(await screen.findByDisplayValue('Bench')).toBeTruthy()
  })

  it('Ctrl+Z does the same from the keyboard, where Tab cannot reach the toast', async () => {
    server(restoreRoute)
    await open()
    day(TUE1).focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByDisplayValue('Bench')
    await userEvent.keyboard('{Control>}{Delete}{/Control}')
    await screen.findByText('Bench deleted')
    await userEvent.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(sent('POST', '/exercises/restore')).toHaveLength(1))
  })
})

describe('Program page — a refused change says so', () => {
  it('stays on the program when it could not be deleted', async () => {
    server({ 'DELETE /api/programs/p1': { status: 500, body: { error: 'boom' } } })
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Delete program' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/Could not delete this program/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Spring Block' })).toBeTruthy()
  })
})
