// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NewProgram from './NewProgram'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

const bodies = (method: string, path: string) =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => (init?.method ?? 'GET') === method && String(url).split('?')[0] === path)
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

afterEach(() => { vi.useRealTimers() })

describe('New program — dates in one step', () => {
  const routes = (style: unknown = { usable: false, preferredBlockWeeks: null }) => ({
    '/api/athletes': { body: [{ id: 'a1', name: 'Sara' }] },
    '/api/export-styles': { body: [] },
    '/api/style-profile': { body: style },
    'POST /api/programs': { status: 201, body: { id: 'p9' } },
  })

  it('starts next Monday for four weeks, and sends both dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 18, 10)) // Wednesday 18 Nov
    serve(routes())
    renderScreen(<NewProgram />, { path: '/programs/new?athlete_id=a1' })

    expect((screen.getByLabelText(/Start date/) as HTMLInputElement).value).toBe('2026-11-23')
    expect((screen.getByLabelText(/Weeks/) as HTMLInputElement).value).toBe('4')
    expect(screen.getByText('2026-11-23 → 2026-12-20')).toBeTruthy()

    await userEvent.type(screen.getByLabelText(/Program name/), 'Winter block')
    await userEvent.click(screen.getByRole('button', { name: 'Create program' }))
    await waitFor(() => expect(bodies('POST', '/api/programs')).toHaveLength(1))
    expect(bodies('POST', '/api/programs')[0]).toMatchObject({
      athlete_id: 'a1', name: 'Winter block', start_date: '2026-11-23', end_date: '2026-12-20',
    })
  })

  it('suggests a name, uses it when none is typed, and sends the focus', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 18, 10))
    serve(routes())
    renderScreen(<NewProgram />, { path: '/programs/new?athlete_id=a1' })
    await userEvent.selectOptions(screen.getByLabelText('Training focus'), 'strength')
    const name = screen.getByLabelText(/Program name/) as HTMLInputElement
    await waitFor(() => expect(name.placeholder).toBe('Sara · Strength · Nov 2026'))
    await userEvent.click(screen.getByRole('button', { name: 'Create program' }))
    await waitFor(() => expect(bodies('POST', '/api/programs')).toHaveLength(1))
    expect(bodies('POST', '/api/programs')[0]).toMatchObject({ name: 'Sara · Strength · Nov 2026', focus: 'strength' })
  })

  it("defaults to the coach's usual block length", async () => {
    serve(routes({ usable: true, preferredBlockWeeks: 6 }))
    renderScreen(<NewProgram />, { path: '/programs/new?athlete_id=a1' })
    await waitFor(() => expect((screen.getByLabelText(/Weeks/) as HTMLInputElement).value).toBe('6'))
    expect(screen.getByText(/your usual block length/)).toBeTruthy()
  })

  it('moves a mid-week start to the Monday of that week, and says so', async () => {
    serve(routes())
    renderScreen(<NewProgram />, { path: '/programs/new?athlete_id=a1' })
    const start = screen.getByLabelText(/Start date/)
    await userEvent.clear(start)
    await userEvent.type(start, '2026-11-19')
    expect(screen.getByText(/2026-11-16 → /)).toBeTruthy()
    expect(screen.getByText(/start on the Monday of that week/)).toBeTruthy()
  })
})

describe('Program page — name and description', () => {
  const program = {
    id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: 'Old notes', status: 'active',
    start_date: '2026-06-15', end_date: '2026-06-21', created_at: '', updated_at: '',
    enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard',
    bookmarked: 0, has_export_template: false, workouts: [],
  }

  it('renames the program and edits its description', async () => {
    serve({
      '/api/programs/p1': { body: program },
      'PUT /api/programs/p1': { body: { ...program, name: 'Summer Block', description: 'New notes' } },
    })
    renderScreen(<ProgramDetail />, { path: '/programs/p1', route: '/programs/:id' })
    await userEvent.click(await screen.findByRole('button', { name: 'Edit name and description' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Summer Block')
    const desc = within(dialog).getByLabelText('Description')
    await userEvent.clear(desc)
    await userEvent.type(desc, 'New notes')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('heading', { name: 'Summer Block' })).toBeTruthy()
    expect(screen.getByText('New notes')).toBeTruthy()
    expect(bodies('PUT', '/api/programs/p1')).toEqual([{ name: 'Summer Block', description: 'New notes' }])
  })
})
