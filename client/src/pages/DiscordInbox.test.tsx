// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DiscordInbox from './DiscordInbox'
import { renderScreen, serve } from '../test/render'

const connected = {
  '/api/discord/settings': { body: { configured: true } },
  '/api/discord/media': { body: { items: [] } },
  '/api/discord/users': { body: [] },
  '/api/discord/messages/unread': { body: [] },
}

describe('Discord inbox', () => {
  it('sends a coach without a bot to Settings', async () => {
    serve({ ...connected, '/api/discord/settings': { body: { configured: false } } })
    renderScreen(<DiscordInbox />)
    expect(await screen.findByText(/Discord isn’t connected yet/)).toBeTruthy()
  })

  it('does not claim Discord is disconnected when the inbox simply failed to load', async () => {
    // Any failure used to read as "Discord isn't connected yet", sending a coach
    // with a working bot off to set it up again.
    const server = serve({ ...connected, '/api/discord/users': { status: 500, body: { error: 'boom' } } })
    renderScreen(<DiscordInbox />)

    expect(await screen.findByText(/Could not load your Discord inbox/)).toBeTruthy()
    expect(screen.queryByText(/isn’t connected/)).toBeNull()

    server.set('/api/discord/users', { body: [] })
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    // The loaded inbox, with its tabs, replaces the error panel.
    expect((await screen.findAllByRole('tab')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Could not load your Discord inbox/)).toBeNull()
  })
})
