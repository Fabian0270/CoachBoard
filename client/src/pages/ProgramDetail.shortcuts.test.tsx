// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, Route, Routes } from 'react-router-dom'
import ProgramDetail from './ProgramDetail'
import { renderScreen, serve } from '../test/render'

// The buttons at the top of a program, and their menus, from the keyboard.

const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-28', created_at: '', updated_at: '',
  enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false,
  workouts: [{
    id: 'w1', program_id: 'p1', name: '2026-06-15', scheduled_date: '2026-06-15', completed_at: null,
    notes: null, created_at: '',
    exercises: [{
      id: 'e1', workout_id: 'w1', name: 'Squat', sets: '5', reps: '5', weight: null, duration: null,
      distance: null, notes: null, order_index: 0, rest_time: null, intensity: null, load_used: null,
      rpe: null, group_id: null, suggestion_note: null,
    }],
  }],
}

const open = async () => {
  serve({ '/api/programs/p1': { body: program }, '/api/athletes/a1': { body: { id: 'a1', name: 'Sara', email: null } } })
  renderScreen(
    <Routes>
      <Route path="/programs/:id" element={<ProgramDetail />} />
      <Route path="/programs/:id/report" element={<p>Report page</p>} />
    </Routes>,
    { path: '/programs/p1' },
  )
  await screen.findByRole('heading', { name: 'Spring Block' })
}

describe('Program page — going from one program to another', () => {
  it("never shows the previous program's days under the next one's address", async () => {
    let answerNext: (r: { body: unknown }) => void = () => {}
    serve({
      '/api/programs/p1': { body: program },
      '/api/programs/p2': () => new Promise((resolve) => { answerNext = resolve }),
    })
    renderScreen(
      <Routes>
        <Route path="/programs/:id" element={<><Link to="/programs/p2">Next block</Link><ProgramDetail /></>} />
      </Routes>,
      { path: '/programs/p1' },
    )
    await screen.findByRole('heading', { name: 'Spring Block' })
    expect(screen.getByText('Squat')).toBeTruthy()

    await userEvent.click(screen.getByRole('link', { name: 'Next block' }))
    // While the next program loads, the old one's calendar must be gone.
    await waitFor(() => expect(screen.queryByText('Squat')).toBeNull())
    expect(screen.queryByRole('heading', { name: 'Spring Block' })).toBeNull()

    answerNext({ body: { ...program, id: 'p2', name: 'Summer Block', workouts: [] } })
    expect(await screen.findByRole('heading', { name: 'Summer Block' })).toBeTruthy()
  })
})

describe('Program page — shortcuts', () => {
  it('Ctrl+Shift+C opens Columns and Ctrl+Shift+D opens Dates', async () => {
    await open()
    await userEvent.keyboard('{Control>}{Shift>}C{/Shift}{/Control}')
    expect(await screen.findByRole('dialog', { name: 'Columns' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await userEvent.keyboard('{Control>}{Shift>}D{/Shift}{/Control}')
    expect(await screen.findByRole('dialog', { name: 'Dates' })).toBeTruthy()
  })

  it('Ctrl+R goes to the report', async () => {
    await open()
    await userEvent.keyboard('{Control>}r{/Control}')
    expect(await screen.findByText('Report page')).toBeTruthy()
  })

  it('does nothing while a dialog is open', async () => {
    await open()
    await userEvent.keyboard('{Control>}{Shift>}C{/Shift}{/Control}')
    await screen.findByRole('dialog', { name: 'Columns' })
    await userEvent.keyboard('{Control>}r{/Control}')
    expect(screen.queryByText('Report page')).toBeNull()
  })

  it('Ctrl+E opens Export with the first item focused, and the arrows walk it', async () => {
    await open()
    await userEvent.keyboard('{Control>}e{/Control}')
    const menu = await screen.findByRole('menu', { name: 'Export' })
    expect(document.activeElement?.textContent).toBe('Preview Excel')
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toBe('Download as Excel')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(document.activeElement?.textContent).toBe('Email to athlete')
    // Esc closes it and puts the cursor back on the button.
    await userEvent.keyboard('{Escape}')
    expect(menu.isConnected).toBe(false)
    expect(document.activeElement?.textContent).toMatch(/Export/)
  })

  it('opens a week menu by keyboard and walks it with the arrows', async () => {
    await open()
    const w1 = screen.getByRole('button', { name: 'Week 1 actions' })
    w1.focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('menu', { name: 'Week 1' })
    expect(document.activeElement?.textContent).toMatch(/Copy week to/)
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toMatch(/Clear week/)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(w1)
  })
})
