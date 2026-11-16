// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VideoPicker from './VideoPicker'
import { renderScreen, serve } from '../../test/render'

// A failed read of the synced videos is not "no videos yet" (BP6).

describe('VideoPicker', () => {
  it('says the synced videos could not be read, and Try again reads them', async () => {
    const server = serve({ '/api/discord/media': { status: 500, body: { error: 'locked' } } })
    renderScreen(<VideoPicker onPick={() => {}} />)
    expect(await screen.findByText(/Could not load the synced videos/)).toBeTruthy()
    expect(screen.queryByText(/No synced videos yet/)).toBeNull()

    server.set('/api/discord/media', { body: { items: [] } })
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/No synced videos yet/)).toBeTruthy()
  })
})
