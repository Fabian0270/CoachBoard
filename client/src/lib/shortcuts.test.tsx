// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { SHORTCUT_GROUPS } from './shortcuts'
import ProgramDetail from '../pages/ProgramDetail'
import Settings from '../pages/Settings'
import { renderScreen, serve } from '../test/render'

// The list in Settings → Help is data. These keep it honest: every key the
// Help tab names for the program's buttons really does something on the
// program page, and the Help tab shows every group.

const program = {
  id: 'p1', athlete_id: 'a1', name: 'Spring Block', description: null, status: 'active',
  start_date: '2026-06-15', end_date: '2026-06-28', created_at: '', updated_at: '',
  enabled_columns: [], focus: null, export_layout: null, builtin_template: 'coachboard',
  bookmarked: 0, has_export_template: false, workouts: [],
}

/** user-event syntax for a combination such as ['Ctrl', 'Shift', 'C']. */
const press = (combo: string[]) => {
  const mods = combo.slice(0, -1).map((m) => (m === 'Ctrl' ? 'Control' : m))
  const key = combo[combo.length - 1]
  return mods.map((m) => `{${m}>}`).join('') + key.toLowerCase() + [...mods].reverse().map((m) => `{/${m}}`).join('')
}

describe('Settings → Help', () => {
  it('lists every shortcut group', async () => {
    serve({ '/api/settings/email': { body: { configured: false } } })
    renderScreen(<Settings />, { path: '/settings?tab=help' })
    for (const g of SHORTCUT_GROUPS) {
      expect(await screen.findByRole('heading', { name: g.title })).toBeTruthy()
    }
  })
})

describe('The program-button shortcuts the Help tab lists', () => {
  const group = SHORTCUT_GROUPS.find((g) => g.title === 'Program buttons')!
  for (const s of group.shortcuts) {
    it(`${s.keys[0].join('+')} — ${s.does}`, async () => {
      serve({ '/api/programs/p1': { body: program }, '/api/athletes/a1': { body: { id: 'a1', email: null } } })
      renderScreen(
        <Routes>
          <Route path="/programs/:id" element={<ProgramDetail />} />
          <Route path="/programs/:id/report" element={<p>Report page</p>} />
        </Routes>,
        { path: '/programs/p1' },
      )
      await screen.findByRole('heading', { name: 'Spring Block' })
      await userEvent.keyboard(press(s.keys[0]))
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog') ?? screen.queryByRole('menu') ?? screen.queryByText('Report page'),
        ).not.toBeNull(),
      )
    })
  }
})
