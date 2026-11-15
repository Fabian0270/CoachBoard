// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// ---------------------------------------------------------------------------
// The day editor, driven with the keyboard only.
//
// The rule these tests hold: everything that can be done in the day table with
// the mouse can also be done without it. Each test starts from the open day and
// never clicks again.
// ---------------------------------------------------------------------------

const base = {
  workout_id: 'w1', weight: null, duration: null, distance: null, notes: null, rest_time: null,
  intensity: null, load_used: null, rpe: null, group_id: null as string | null, suggestion_note: null,
}
type Row = typeof base & { id: string; name: string; sets: string | null; reps: string | null; order_index: number }
const squat: Row = { ...base, id: 'e1', name: 'Squat', sets: '3', reps: '5', order_index: 0 }
const rows: Row = { ...base, id: 'e2', name: 'Rows', sets: '3', reps: '10', order_index: 1 }

const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
  // Exercise, Sets and Reps only: a short row to walk.
  enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [{
    id: 'w1', program_id: 'p1', name: 'Day 1', scheduled_date: '2026-06-15', completed_at: null,
    notes: null, created_at: '', exercises: [squat, rows],
  }],
}

const cell = () => (document.activeElement as HTMLElement).getAttribute('data-cell')
const names = () =>
  [...document.querySelectorAll<HTMLTextAreaElement>('[data-cell$=":name"]')].map((e) => e.value)

/** The body each PUT carried. */
const putBodies = (): Record<string, unknown>[] =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

/** A server that stores what it is sent, so the table reflects every key. */
const liveServer = () => {
  let list: Row[] = [squat, rows]
  const put = (id: string) => (_u: URL, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body)) as Partial<Row>
    list = list.map((e) => (e.id === id ? { ...e, ...patch } : e))
    return { body: list.find((e) => e.id === id) }
  }
  return serve({
    '/api/programs/p1': { body: program },
    'PUT /api/programs/p1/workouts/w1/exercises/e1': put('e1'),
    'PUT /api/programs/p1/workouts/w1/exercises/e2': put('e2'),
    'POST /api/programs/p1/workouts/w1/exercises': () => {
      const made: Row = { ...base, id: 'e3', name: '', sets: null, reps: null, order_index: list.length }
      list = [...list, made]
      return { status: 201, body: made }
    },
    'POST /api/programs/p1/workouts/w1/exercises/e1/add-set': () => {
      list = [{ ...squat, group_id: 'g1' }, { ...squat, id: 'e1b', group_id: 'g1', order_index: 1 }, { ...rows, order_index: 2 }]
      return { status: 201, body: { exercises: list } }
    },
    'POST /api/programs/p1/workouts/w1/exercises/e1/duplicate': () => {
      list = [squat, { ...squat, id: 'e1c', order_index: 1 }, { ...rows, order_index: 2 }]
      return { status: 201, body: { exercises: list, newIds: ['e1c'] } }
    },
    'PUT /api/programs/p1/workouts/w1/exercises/reorder': (_u, init) => {
      const { exerciseIds } = JSON.parse(String(init?.body)) as { exerciseIds: string[] }
      list = exerciseIds.map((id, i) => ({ ...list.find((e) => e.id === id)!, order_index: i }))
      return { body: { exercises: list } }
    },
    'DELETE /api/programs/p1/workouts/w1/exercises/e1': () => {
      list = list.filter((e) => e.id !== 'e1')
      return { status: 204 }
    },
  })
}

const openDay = async () => {
  renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
  await userEvent.click(await screen.findByText('Squat'))
  await waitFor(() => expect(cell()).toBe('e1:name'))
}

describe('Day editor — keyboard only', () => {
  it('Enter walks the fields, then the next exercise, then adds a new one', async () => {
    const server = liveServer()
    await openDay()
    await userEvent.keyboard('{Enter}')
    expect(cell()).toBe('e1:sets')
    await userEvent.keyboard('{Enter}')
    expect(cell()).toBe('e1:reps')
    await userEvent.keyboard('{Enter}')
    expect(cell()).toBe('e2:name')
    await userEvent.keyboard('{Enter}{Enter}')
    expect(cell()).toBe('e2:reps')
    // The last field of the last exercise.
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(cell()).toBe('e3:name'))
    expect(server.calls.filter((c) => c === 'POST /api/programs/p1/workouts/w1/exercises')).toHaveLength(1)
  })

  it('saves what was typed as Enter moves on, and Shift+Enter makes a line break instead', async () => {
    liveServer()
    await openDay()
    await userEvent.keyboard('{Enter}')    // to Sets, with its text selected
    await userEvent.keyboard('6{Enter}')   // type over it and move on
    expect(cell()).toBe('e1:reps')
    await waitFor(() => expect(putBodies()).toContainEqual({ sets: '6' }))
    await userEvent.keyboard('8{Shift>}{Enter}{/Shift}10')
    expect(cell()).toBe('e1:reps')
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('8\n10')
  })

  it('Up and Down move to the same field on the row above and below', async () => {
    liveServer()
    await openDay()
    await userEvent.keyboard('{Enter}')
    expect(cell()).toBe('e1:sets')
    await userEvent.keyboard('{ArrowDown}')
    expect(cell()).toBe('e2:sets')
    await userEvent.keyboard('{ArrowUp}')
    expect(cell()).toBe('e1:sets')
  })

  it('Tab walks the cells and skips the small row buttons', async () => {
    liveServer()
    await openDay()
    await userEvent.tab()
    expect(cell()).toBe('e1:sets')
    await userEvent.tab()
    expect(cell()).toBe('e1:reps')
    await userEvent.tab()
    expect(cell()).toBe('e2:name')
  })

  it('Ctrl+Enter adds a set and puts the cursor in it', async () => {
    liveServer()
    await openDay()
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(cell()).toBe('e1b:sets'))
  })

  it('Ctrl+D duplicates the exercise and puts the cursor in the copy', async () => {
    liveServer()
    await openDay()
    await userEvent.keyboard('{Control>}d{/Control}')
    await waitFor(() => expect(cell()).toBe('e1c:name'))
  })

  it('Ctrl+Delete deletes the exercise and moves the cursor to the next one', async () => {
    const server = liveServer()
    await openDay()
    await userEvent.keyboard('{Control>}{Delete}{/Control}')
    await waitFor(() => expect(names()).toEqual(['Rows']))
    await waitFor(() => expect(cell()).toBe('e2:name'))
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(0)
  })

  it('Alt+Down moves the exercise below the next one and keeps the cursor on it', async () => {
    liveServer()
    await openDay()
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() => expect(names()).toEqual(['Rows', 'Squat']))
    await waitFor(() => expect(cell()).toBe('e1:name'))
  })

  it('suggests names by keyboard, and the first Esc closes only the list', async () => {
    liveServer()
    await openDay()
    // Opening a day must not open a list over its first exercise.
    expect(screen.queryByRole('listbox')).toBeNull()

    await userEvent.keyboard('{Control>}a{/Control}Front')
    expect((await screen.findByRole('listbox')).textContent).toMatch(/Front Squat/)

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()

    // Typing again reopens it; Arrow Down then Enter takes the suggestion.
    await userEvent.keyboard(' ')
    await screen.findByRole('listbox')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await waitFor(() =>
      expect(putBodies().some((b) => typeof b.name === 'string' && /Front Squat/.test(b.name))).toBe(true),
    )
    expect(cell()).toBe('e1:sets')

    // With no list open, Esc closes the day.
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Day editor — Load Cap', () => {
  const openWithLoadCap = async () => {
    const server = liveServer()
    server.set('/api/programs/p1', { body: { ...program, enabled_columns: ['load_cap'] } })
    await openDay()
    await userEvent.keyboard('{Enter}{Enter}{Enter}')
    expect(cell()).toBe('e1:load_cap')
    return server
  }

  it('takes a decimal comma, the way a Swedish keyboard types it', async () => {
    await openWithLoadCap()
    await userEvent.keyboard('102,5{Enter}')
    await waitFor(() => expect(putBodies()).toContainEqual({ weight: 102.5 }))
  })

  it('does not keep text that is not a number looking as if it were saved', async () => {
    const server = await openWithLoadCap()
    await userEvent.keyboard('heavy{Enter}')
    expect(await screen.findByText(/takes a number/)).toBeTruthy()
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(0)
    expect(screen.queryByDisplayValue('heavy')).toBeNull()
  })
})
