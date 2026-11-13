// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExportStyles from './ExportStyles'
import { renderScreen, serve } from '../test/render'

describe('Excel Styles page', () => {
  it('lists saved styles', async () => {
    serve({ '/api/export-styles': { body: [{ id: 's1', name: 'Coach Anna', descriptor: { orientation: 'vertical' }, created_at: '' }] } })
    renderScreen(<ExportStyles />)
    expect(await screen.findByText('Coach Anna')).toBeTruthy()
  })

  it('says there are none only when there really are none', async () => {
    serve({ '/api/export-styles': { body: [] } })
    renderScreen(<ExportStyles />)
    expect(await screen.findByText(/No saved styles yet/)).toBeTruthy()
  })

  it('shows a failed load as a failure, not as "no saved styles", and recovers on retry', async () => {
    const server = serve({ '/api/export-styles': { status: 500, body: { error: 'boom' } } })
    renderScreen(<ExportStyles />)

    expect(await screen.findByText(/Could not load your saved styles/)).toBeTruthy()
    expect(screen.queryByText(/No saved styles yet/)).toBeNull()

    server.set('/api/export-styles', { body: [{ id: 's1', name: 'Coach Anna', descriptor: { orientation: 'vertical' }, created_at: '' }] })
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(await screen.findByText('Coach Anna')).toBeTruthy()
  })
})
