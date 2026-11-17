// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DiscordInbox from './DiscordInbox'
import { renderScreen, serve } from '../test/render'
import type { CaptionLogCandidates, CaptionLogRow, DiscordMediaItem } from 'coachboard-shared/discord'

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

// L1 (D10, D66): logging the caption's result when attaching, only when ticked.
describe('logging a caption result', () => {
  const item: DiscordMediaItem = {
    id: 'm1', channelId: 'c1', channelName: '#form-checks', messageId: 'msg1', discordUserId: 'u1',
    authorUsername: 'ada', authorDisplayName: null, authorAvatarUrl: null,
    athleteId: 'a1', athleteName: 'Ada', workoutId: null, workoutName: null, workoutDate: null,
    suggestedWorkoutId: 'w1', suggestedWorkoutName: 'Day 1', suggestedWorkoutDate: '2026-11-17',
    programId: 'p1', programName: 'Block', filename: 'v.mp4', contentType: 'video/mp4', sizeBytes: 1,
    width: null, height: null, caption: 'squat 180x3 @8',
    parsedCaption: { weightKg: 180, reps: 3, rpe: 8, liftKeywords: ['squat'] },
    postedAt: '2026-11-17T10:00:00.000Z', downloadStatus: 'downloaded', downloadError: null,
    duplicateOfId: null, reviewed: false, playable: false, isVideo: true, thumbUrl: null,
    thumbStatus: 'unsupported', durationMs: null, analysisCount: 0,
  }
  const row = (over: Partial<CaptionLogRow>): CaptionLogRow => ({
    exerciseId: 'e1', name: 'Squat', sets: '1', reps: '3', weight: 180, intensity: null,
    loadUsed: null, rpe: null, alreadyLogged: false, fits: true, ...over,
  })
  const inbox = (rows: CaptionLogRow[]) => serve({
    ...connected,
    '/api/discord/media': (url) => ({ body: { items: url.searchParams.get('filter') === 'unreviewed' ? [item] : [] } }),
    'POST /api/discord/media/m1/workout': { body: {} },
    '/api/discord/media/m1/log-candidates': {
      body: { caption: item.parsedCaption!, rows } satisfies CaptionLogCandidates,
    },
    'POST /api/discord/media/m1/log': { body: {} },
  })

  it('attaches without logging unless the box is ticked', async () => {
    const server = inbox([row({})])
    renderScreen(<DiscordInbox />)
    await userEvent.click(await screen.findByRole('tab', { name: /Needs review/ }))
    expect(await screen.findByLabelText(/Also log 180 kg × 3 @8 on the day/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(await screen.findByText('Attached to the training day')).toBeTruthy()
    expect(server.calls.some((c) => c.includes('/log'))).toBe(false)
  })

  it('logs straight onto the one row that fits', async () => {
    const server = inbox([row({}), row({ exerciseId: 'e2', name: 'Bench', fits: false })])
    renderScreen(<DiscordInbox />)
    await userEvent.click(await screen.findByRole('tab', { name: /Needs review/ }))
    await userEvent.click(await screen.findByLabelText(/Also log/))
    await userEvent.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(await screen.findByText('Logged 180 kg × 3 @8 on Squat')).toBeTruthy()
    expect(server.calls).toContain('POST /api/discord/media/m1/log')
  })

  it('lets the coach pick when several rows fit, and will not pick a logged one', async () => {
    const server = inbox([
      row({ exerciseId: 'e1', reps: '5' }),
      row({ exerciseId: 'e2', name: 'Squat', alreadyLogged: true, loadUsed: '175', rpe: '8' }),
      row({ exerciseId: 'e3', name: 'Back-off squat', reps: '3' }),
    ])
    let body = ''
    server.set('POST /api/discord/media/m1/log', (_url, init) => { body = String(init?.body); return { body: {} } })
    renderScreen(<DiscordInbox />)
    await userEvent.click(await screen.findByRole('tab', { name: /Needs review/ }))
    await userEvent.click(await screen.findByLabelText(/Also log/))
    await userEvent.click(screen.getByRole('button', { name: /Confirm/ }))

    expect(await screen.findByText('Log the result on which row?')).toBeTruthy()
    const logged = screen.getByText(/Already logged: 175 @8/).closest('button')!
    expect(logged.disabled).toBe(true)
    // Planned 5, the caption says 3: the picker says what happens.
    expect(screen.getByText('3 reps will be noted as done (planned 5)')).toBeTruthy()
    await userEvent.click(screen.getByText('Back-off squat'))
    expect(await screen.findByText('Logged 180 kg × 3 @8 on Back-off squat')).toBeTruthy()
    expect(JSON.parse(body)).toEqual({ exerciseId: 'e3' })
  })
})
