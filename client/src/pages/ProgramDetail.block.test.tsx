// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// The block view (1E): one weekday, exercises down the side, weeks across.

type Ex = Record<string, unknown> & { id: string; workout_id: string; name: string; order_index: number; group_id: string | null }
type Day = { id: string; program_id: string; name: string; scheduled_date: string; completed_at: null; notes: string | null; created_at: string; exercises: Ex[] }

const ex = (id: string, workout_id: string, extra: Partial<Ex>): Ex => ({
  id, workout_id, name: 'Squat', sets: '5', reps: '5', weight: null, duration: null, distance: null,
  notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null, rpe: null,
  group_id: null, suggestion_note: null, ...extra,
})
const day = (id: string, date: string, exercises: Ex[]): Day => ({
  id, program_id: 'p1', name: date, scheduled_date: date, completed_at: null, notes: null, created_at: '', exercises,
})

/**
 * A program that changes as the page changes it, so what the page shows after
 * a save, a creation or an undo is what a real server would hand back.
 */
function fakeProgram() {
  let n = 0
  const state = {
    id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
    start_date: '2026-06-15', end_date: '2026-07-05', created_at: '', updated_at: '',
    enabled_columns: ['intensity', 'load_cap'], focus: null, export_layout: null, builtin_template: 'coachboard',
    bookmarked: 0, has_export_template: false,
    workouts: [
      // Week 1 Monday: Squat and Bench. Week 2 Monday: Squat only. Week 3: no Monday at all.
      day('w1', '2026-06-15', [
        ex('a1', 'w1', { intensity: 'RPE 8', weight: 140 }),
        ex('a2', 'w1', { name: 'Bench', sets: '4', reps: '8', order_index: 1 }),
      ]),
      day('w2', '2026-06-22', [ex('b1', 'w2', { intensity: 'RPE 8.5', weight: 142.5 })]),
      // A Thursday, so the weekday picker has two days to offer.
      day('t1', '2026-06-18', [ex('d1', 't1', { name: 'Deadlift' })]),
    ] as Day[],
  }
  const workout = (wid: string) => state.workouts.find((w) => w.id === wid)!
  const renumber = (w: Day) => w.exercises.forEach((e, i) => { e.order_index = i })
  const body = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'))

  const server = serve({
    'GET /api/programs/p1': () => ({ body: structuredClone(state) }),
    'POST /api/programs/p1/workouts': (_u, init) => {
      const b = body(init)
      const w = day(`new-w${++n}`, b.scheduled_date, [])
      state.workouts.push(w)
      return { status: 201, body: { ...w, exercises: undefined } }
    },
    'PUT /api/programs/p1/days/restore': (_u, init) => {
      const { days } = body(init) as { days: { date: string; workout: (Day & { mediaIds: string[] }) | null }[] }
      for (const d of days) {
        state.workouts = state.workouts.filter((w) => w.scheduled_date !== d.date)
        if (d.workout) state.workouts.push({ ...d.workout, program_id: 'p1', scheduled_date: d.date })
      }
      return { body: structuredClone(state) }
    },
  })
  // A creation can be held in flight, to act while it is.
  let gate: Promise<void> | null = null
  const hold = () => {
    let release = () => {}
    gate = new Promise<void>((r) => { release = () => { gate = null; r() } })
    return release
  }
  // Routes with the workout or exercise id in the path.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (b: unknown, status = 200) => {
      server.calls.push(`${method} ${url.pathname}`)
      return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    }
    let m = url.pathname.match(/^\/api\/programs\/p1\/workouts\/([^/]+)\/exercises\/paste$/)
    if (m && method === 'POST') {
      if (gate) await gate
      const w = workout(m[1])
      const { anchorId, rows } = body(init) as { anchorId: string | null; rows: Partial<Ex>[] }
      const at = anchorId ? w.exercises.findIndex((e) => e.id === anchorId) + 1 : w.exercises.length
      const made = rows.map((r) => ex(`new-e${++n}`, w.id, { sets: null, reps: null, ...r }))
      w.exercises.splice(at, 0, ...made)
      renumber(w)
      return json({ exercises: w.exercises, newIds: made.map((e) => e.id) }, 201)
    }
    m = url.pathname.match(/^\/api\/programs\/p1\/workouts\/([^/]+)\/exercises\/([^/]+)\/add-set$/)
    if (m && method === 'POST') {
      // A copy of the set, after the last row of its exercise.
      const w = workout(m[1])
      const src = w.exercises.find((e) => e.id === m![2])!
      const group = src.group_id ?? `g${++n}`
      src.group_id = group
      const last = w.exercises.map((e, i) => (e.id === src.id || e.group_id === group ? i : -1)).reduce((a, b) => Math.max(a, b))
      w.exercises.splice(last + 1, 0, { ...src, id: `new-e${++n}` })
      renumber(w)
      return json({ exercises: w.exercises }, 201)
    }
    m = url.pathname.match(/^\/api\/programs\/p1\/workouts\/([^/]+)\/exercises\/reorder$/)
    if (m && method === 'PUT') {
      const w = workout(m[1])
      const ids = (body(init) as { exerciseIds: string[] }).exerciseIds
      w.exercises = ids.map((i) => w.exercises.find((e) => e.id === i)!)
      renumber(w)
      return json({ exercises: w.exercises })
    }
    m = url.pathname.match(/^\/api\/programs\/p1\/workouts\/([^/]+)\/exercises\/([^/]+)$/)
    if (m && method === 'PUT') {
      const e = workout(m[1]).exercises.find((x) => x.id === m![2])!
      Object.assign(e, body(init))
      return json(e)
    }
    return realFetch(input, init)
  }) as typeof fetch
  return { state, calls: server.calls, hold }
}

const open = async () => {
  renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
  await screen.findByRole('heading', { name: 'Spring Block' })
  await userEvent.click(screen.getByRole('button', { name: 'Block' }))
  return screen.findByRole('table', { name: 'Mondays, week by week' })
}
const cell = (label: string) => screen.getByRole('textbox', { name: label }) as HTMLInputElement

describe('Block view', () => {
  it('shows one weekday, exercises down the side and every week across', async () => {
    fakeProgram()
    const table = await open()
    expect(screen.getByRole('button', { name: 'Block' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Squat', 'Bench', ''])
    for (const w of ['Week 1', 'Week 2', 'Week 3']) expect(within(table).getByText(w)).toBeTruthy()
    expect(cell('Squat, week 1, Load Cap').value).toBe('140')
    expect(cell('Squat, week 2, Intensity/Weight').value).toBe('RPE 8.5')
    // Weeks without the exercise are there to type into.
    expect(cell('Bench, week 2, Sets').value).toBe('')
    expect(cell('Squat, week 3, Sets').value).toBe('')

    await userEvent.click(screen.getByRole('button', { name: /^Thu/ }))
    expect(await screen.findByRole('table', { name: 'Thursdays, week by week' })).toBeTruthy()
    expect(cell('Deadlift, week 1, Sets').value).toBe('5')

    // And back: the calendar is where it was.
    await userEvent.click(screen.getByRole('button', { name: 'Calendar' }))
    expect(document.querySelector('[data-day="2026-06-15"]')).not.toBeNull()
  })

  it('saves an edited cell, and Enter walks the fields and on into the next week', async () => {
    const { state } = fakeProgram()
    await open()
    await userEvent.click(cell('Squat, week 1, Load Cap'))
    await userEvent.keyboard('{Control>}a{/Control}145{Enter}')
    // Load Cap was the last field of week 1: Enter goes on to week 2's first.
    expect(document.activeElement).toBe(cell('Squat, week 2, Sets'))
    await waitFor(() => expect(state.workouts[0].exercises[0].weight).toBe(145))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cell('Bench, week 2, Sets'))
  })

  it('typing into a week without the exercise creates it there, once, in its place', async () => {
    const { state, calls, hold } = fakeProgram()
    await open()
    // Week 2 has Squat but no Bench: Bench goes in under Squat. The second
    // value is typed while the first is still creating the exercise.
    const release = hold()
    await userEvent.click(cell('Bench, week 2, Sets'))
    await userEvent.keyboard('3{Enter}10{Enter}')
    release()
    await waitFor(() => expect(state.workouts[1].exercises.map((e) => [e.name, e.sets, e.reps])).toEqual([
      ['Squat', '5', '5'], ['Bench', '3', '10'],
    ]))
    // The second value went into the same new exercise, not a second Bench.
    expect(calls.filter((c) => c.endsWith('/exercises/paste'))).toHaveLength(1)
    expect(cell('Bench, week 2, Reps').value).toBe('10')
  })

  it('…also on a week with no day yet, where the day is created first (seen in the packaged build)', async () => {
    const { state, calls, hold } = fakeProgram()
    await open()
    const release = hold()
    await userEvent.click(cell('Squat, week 3, Sets'))
    await userEvent.keyboard('3{Enter}8{Enter}')
    release()
    await waitFor(() => {
      const monday = state.workouts.find((w) => w.scheduled_date === '2026-06-29')
      expect(monday?.exercises.map((e) => [e.name, e.sets, e.reps])).toEqual([['Squat', '3', '8']])
    })
    expect(calls.filter((c) => c.endsWith('/exercises/paste'))).toHaveLength(1)
  })

  it('after Ctrl+Z took a created exercise away, typing there creates it again', async () => {
    const { state, calls } = fakeProgram()
    await open()
    await userEvent.click(cell('Bench, week 2, Sets'))
    await userEvent.keyboard('3{Enter}')
    await waitFor(() => expect(state.workouts[1].exercises.map((e) => e.name)).toEqual(['Squat', 'Bench']))
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(state.workouts.find((w) => w.id === 'w2')!.exercises.map((e) => e.name)).toEqual(['Squat']))
    await waitFor(() => expect(cell('Bench, week 2, Sets').placeholder).toBe('+'))

    await userEvent.click(cell('Bench, week 2, Reps'))
    await userEvent.keyboard('12{Enter}')
    await waitFor(() => expect(state.workouts.find((w) => w.id === 'w2')!.exercises.map((e) => [e.name, e.reps])).toEqual([
      ['Squat', '5'], ['Bench', '12'],
    ]))
    expect(calls.filter((c) => c.endsWith('/exercises/paste'))).toHaveLength(2)
  })

  it('a missing further set is added as a set of its exercise', async () => {
    const { state, calls } = fakeProgram()
    // Week 1's Squat has a second set; week 2's has one.
    state.workouts[0].exercises = [
      ex('a1', 'w1', { sets: '1', reps: '3', group_id: 'g', weight: 160 }),
      ex('a3', 'w1', { sets: '3', reps: '5', group_id: 'g', weight: 140, order_index: 1 }),
    ]
    await open()
    expect(screen.getByRole('rowheader', { name: 'Squat, next set' })).toBeTruthy()
    await userEvent.click(cell('Squat (next set), week 2, Reps'))
    await userEvent.keyboard('6{Enter}')
    await waitFor(() => expect(state.workouts[1].exercises.map((e) => [e.name, e.reps, e.group_id !== null])).toEqual([
      ['Squat', '5', true], ['Squat', '6', true],
    ]))
    expect(calls.some((c) => c.endsWith('/add-set'))).toBe(true)
    expect(calls.some((c) => c.endsWith('/paste'))).toBe(false)
  })

  it('a week with no training on that day gets the day created', async () => {
    const { state, calls } = fakeProgram()
    await open()
    await userEvent.click(cell('Squat, week 3, Intensity/Weight'))
    await userEvent.keyboard('RPE 9{Enter}')
    await waitFor(() => {
      const monday = state.workouts.find((w) => w.scheduled_date === '2026-06-29')
      expect(monday?.exercises.map((e) => [e.name, e.intensity])).toEqual([['Squat', 'RPE 9']])
    })
    expect(calls).toContain('POST /api/programs/p1/workouts')
  })

  it('a new row goes into every week, and one Ctrl+Z takes it back out of all of them', async () => {
    const { state, calls } = fakeProgram()
    await open()
    await userEvent.click(screen.getByRole('combobox', { name: 'New exercise in every Monday' }))
    await userEvent.keyboard('Romanian Deadlift{Enter}')
    await waitFor(() => {
      for (const date of ['2026-06-15', '2026-06-22', '2026-06-29']) {
        const w = state.workouts.find((x) => x.scheduled_date === date)
        expect(w?.exercises.at(-1)?.name, date).toBe('Romanian Deadlift')
      }
    })
    expect(await screen.findByText('Added Romanian Deadlift to every Monday')).toBeTruthy()
    // The cursor is in the new row, ready for its numbers.
    await waitFor(() => expect(document.activeElement).toBe(cell('Romanian Deadlift, week 1, Sets')))

    document.activeElement instanceof HTMLElement && document.activeElement.blur()
    await userEvent.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(calls).toContain('PUT /api/programs/p1/days/restore'))
    await waitFor(() => expect(state.workouts.some((w) => w.exercises.some((e) => e.name === 'Romanian Deadlift'))).toBe(false))
    // Week 3 had no Monday before, and has none again.
    expect(state.workouts.find((w) => w.scheduled_date === '2026-06-29')).toBeUndefined()
  })

  it('Ctrl+Z undoes a cell edit made here', async () => {
    const { state } = fakeProgram()
    await open()
    await userEvent.click(cell('Squat, week 2, Load Cap'))
    await userEvent.keyboard('{Control>}a{/Control}150{Enter}')
    await waitFor(() => expect(state.workouts[1].exercises[0].weight).toBe(150))
    await userEvent.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(state.workouts.find((w) => w.id === 'w2')!.exercises[0].weight).toBe(142.5))
    await waitFor(() => expect(cell('Squat, week 2, Load Cap').value).toBe('142.5'))
  })

  it('a Load Cap that is not a number is not saved', async () => {
    const { calls } = fakeProgram()
    await open()
    await userEvent.click(cell('Squat, week 1, Load Cap'))
    await userEvent.keyboard('{Control>}a{/Control}heavy{Enter}')
    expect(await screen.findByText('Load Cap takes a number, so "heavy" was not saved.')).toBeTruthy()
    expect(cell('Squat, week 1, Load Cap').value).toBe('140')
    expect(calls.some((c) => c.startsWith('PUT /api/programs/p1/workouts/'))).toBe(false)
  })

  it('a week heading opens that day in the day editor', async () => {
    fakeProgram()
    await open()
    await userEvent.click(screen.getByRole('button', { name: /^Week 2/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Week 2 · Monday · 22 Jun')).toBeTruthy()
  })

  it('the arrow keys land in the grid with nothing focused', async () => {
    fakeProgram()
    await open()
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cell('Squat, week 1, Sets'))
  })
})
