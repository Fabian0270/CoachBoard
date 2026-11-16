// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import NewProgramChooser from './NewProgramChooser'
import { renderScreen, serve } from '../test/render'

const programs = [
  { id: 'p1', name: 'Old block', status: 'completed', athlete_id: 'a1', start_date: '2026-01-05', bookmarked: 0 },
  { id: 'p2', name: 'Favourite block', status: 'completed', athlete_id: 'a1', start_date: '2025-09-01', bookmarked: 1 },
  { id: 'p3', name: 'Peaking template', status: 'active', athlete_id: null, start_date: '2025-01-06', bookmarked: 0 },
]
const athletes = [{ id: 'a1', name: 'Sara' }, { id: 'a2', name: 'Tom' }]

const open = (props: Partial<Parameters<typeof NewProgramChooser>[0]> = {}) =>
  renderScreen(
    <Routes>
      <Route path="/" element={<NewProgramChooser open onOpenChange={() => {}} onGenerate={() => {}} onImport={() => {}} {...props} />} />
      <Route path="/programs/new" element={<p>New program form</p>} />
    </Routes>,
  )

describe('New program chooser', () => {
  it('offers the four ways to start', () => {
    serve({})
    open()
    for (const name of [/Blank/, /From an existing program or template/, /Generate the next block/, /Import from Excel/]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })

  it('Blank opens the form, for the athlete when on their page', async () => {
    serve({})
    open({ athleteId: 'a2' })
    await userEvent.click(screen.getByRole('button', { name: /Blank/ }))
    expect(await screen.findByText('New program form')).toBeTruthy()
  })

  it('hands Generate and Import to the page', async () => {
    const onGenerate = vi.fn()
    const onImport = vi.fn()
    serve({})
    open({ onGenerate, onImport })
    await userEvent.click(screen.getByRole('button', { name: /Generate the next block/ }))
    expect(onGenerate).toHaveBeenCalled()
  })

  it('lists templates and bookmarked programs first, and copies the one picked', async () => {
    serve({ '/api/programs': { body: programs }, '/api/athletes': { body: athletes } })
    open({ athleteId: 'a2' })
    await userEvent.click(screen.getByRole('button', { name: /From an existing program/ }))
    await screen.findByText('Old block')
    const names = [...document.querySelectorAll('[role="dialog"] button .truncate')].map((e) => e.textContent)
    expect(names).toEqual(['Peaking template', 'Favourite block', 'Old block'])

    await userEvent.click(screen.getByText('Peaking template'))
    const dup = await screen.findByRole('dialog', { name: /Duplicate “Peaking template”/ })
    // For the athlete whose page it was started from.
    expect(dup).toBeTruthy()
    await screen.findByRole('option', { name: 'Tom' })
    expect((screen.getByLabelText('For') as HTMLSelectElement).value).toBe('a2')
  })
})
