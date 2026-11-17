// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FeedbackPanel from './FeedbackPanel'
import { renderScreen, serve } from '../../test/render'

// The feedback message for the athlete (BP36, D61).

const user = (athleteId: string | null) => ({ id: 'u1', username: 'anna', displayName: null, avatarUrl: null, athleteId, athleteName: null, mediaCount: 0, firstSeenAt: '' })

describe('FeedbackPanel', () => {
  it('no Send without a linked Discord account; Copy still there', async () => {
    serve({ '/api/discord/users': { body: [user('someone-else')] } })
    renderScreen(<FeedbackPanel draft="Back squat 150 kg — 3 reps." athleteId="a1" athleteName="Anna" makeImage={null} />)
    expect(await screen.findByText(/Link Anna to a Discord account/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Send to Discord/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy()
  })

  it('sends the edited message with the image as a DM', async () => {
    let sent: { url: string; type: string | null } | null = null
    serve({
      '/api/discord/users': { body: [user('a1')] },
      'POST /api/discord/athletes/a1/dm-image': (url, init) => {
        sent = { url: url.search, type: new Headers(init?.headers).get('Content-Type') }
        return { body: { status: 'sent' } }
      },
    })
    renderScreen(<FeedbackPanel draft="Back squat 150 kg — 3 reps." athleteId="a1" athleteName="Anna" makeImage={() => Promise.resolve(new Blob(['png'], { type: 'image/png' }))} />)
    const box = screen.getByRole('textbox', { name: 'Feedback message' })
    await userEvent.type(box, ' Great depth.')
    await userEvent.click(await screen.findByRole('button', { name: /Send to Discord/ }))
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent!.type).toBe('image/png')
    expect(decodeURIComponent(sent!.url)).toContain('message=Back squat 150 kg — 3 reps. Great depth.')
    expect(await screen.findByText('Sent to Anna on Discord.')).toBeTruthy()
  })
})
