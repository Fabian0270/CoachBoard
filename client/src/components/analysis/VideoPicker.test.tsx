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

  // BP19: which clips are done, and the rest of the inbox past the first page.
  const clip = (id: string, athleteName: string, analysisCount = 0) => ({
    id, athleteName, authorUsername: 'u', filename: `${id}.mp4`, caption: null, postedAt: '2026-11-10T10:00:00Z',
    isVideo: true, playable: true, thumbUrl: null, durationMs: null, analysisCount,
  })

  it('marks the clips that already have an analysis', async () => {
    serve({ '/api/discord/media': { body: { items: [clip('a', 'Ann', 1), clip('b', 'Bo')], total: 2 } } })
    renderScreen(<VideoPicker onPick={() => {}} />)
    const ann = (await screen.findByText('Ann')).closest('button')!
    const bo = screen.getByText('Bo').closest('button')!
    expect(ann.textContent).toContain('Done')
    expect(bo.textContent).not.toContain('Done')
  })

  it('says when there are more than it read, and reads the older ones', async () => {
    const server = serve({
      '/api/discord/media': (url) => ({
        body: url.searchParams.get('offset') === '1'
          ? { items: [clip('b', 'Bo')], total: 2 }
          : { items: [clip('a', 'Ann')], total: 2 },
      }),
    })
    renderScreen(<VideoPicker onPick={() => {}} />)
    expect(await screen.findByText(/The newest 1 of 2 synced files/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Show older ones' }))
    expect(await screen.findByText('Bo')).toBeTruthy()
    expect(screen.queryByText(/The newest/)).toBeNull()
    expect(server.calls.some((c) => c.includes('offset=1'))).toBe(true)
  })
})
