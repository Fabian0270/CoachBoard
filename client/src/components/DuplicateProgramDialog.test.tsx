// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import DuplicateProgramDialog from './DuplicateProgramDialog'
import { renderScreen, serve } from '../test/render'

const source = { id: 'p1', name: 'Sara block', athlete_id: 'a1' }
const athletes = [{ id: 'a1', name: 'Sara' }, { id: 'a2', name: 'Tom' }]

const sent = () =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === 'POST' && String(url).endsWith('/duplicate'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

const open = () =>
  renderScreen(
    <Routes>
      <Route path="/" element={<DuplicateProgramDialog program={source} open onOpenChange={() => {}} />} />
      <Route path="/programs/:id" element={<p>Opened the copy</p>} />
    </Routes>,
  )

describe('Duplicate program', () => {
  it("copies to another athlete, scaling to their maxes, and opens the copy", async () => {
    serve({
      '/api/athletes': { body: athletes },
      'POST /api/programs/p1/duplicate': { status: 201, body: { id: 'p9', scaled: 3, notScaled: 1 } },
    })
    open()
    await screen.findByRole('option', { name: 'Tom' })
    await userEvent.selectOptions(screen.getByLabelText('For'), 'a2')
    expect((screen.getByLabelText(/Scale loads/) as HTMLInputElement).checked).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() => expect(sent()).toHaveLength(1))
    expect(sent()[0]).toMatchObject({ athlete_id: 'a2', name: 'Sara block (copy)', keep_results: false, scale_loads: true })
    expect(await screen.findByText('Opened the copy')).toBeTruthy()
    expect(screen.getByText(/3 loads scaled .* 1 kept as they were/)).toBeTruthy()
  })

  it('cannot scale when copying for the same athlete or as a template', async () => {
    serve({ '/api/athletes': { body: athletes } })
    open()
    await screen.findByRole('option', { name: 'Tom' })
    const scale = screen.getByLabelText(/Scale loads/) as HTMLInputElement
    expect(scale.disabled).toBe(true)
    await userEvent.selectOptions(screen.getByLabelText('For'), '__template__')
    expect(scale.disabled).toBe(true)
  })

  it('saves a template with no athlete', async () => {
    serve({
      '/api/athletes': { body: athletes },
      'POST /api/programs/p1/duplicate': { status: 201, body: { id: 'p9', scaled: 0, notScaled: 0 } },
    })
    open()
    await screen.findByRole('option', { name: 'Tom' })
    await userEvent.selectOptions(screen.getByLabelText('For'), '__template__')
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    await waitFor(() => expect(sent()[0]).toMatchObject({ athlete_id: null, scale_loads: false }))
  })
})
