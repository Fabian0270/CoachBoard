// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BackupMirrorSection, { type MirrorStatus } from './BackupMirrorSection'
import { useBackupMirrorAlert } from '../hooks/useBackupMirrorAlert'
import { renderScreen, serve } from '../test/render'

// N4 (D91–D94): the second backup folder in Settings, and the one-time message.

const off: MirrorStatus = { dir: null, lastCopiedAt: null, lastCopiedFile: null, error: null, failingSince: null, canPick: true }
const on: MirrorStatus = { ...off, dir: 'C:\\Users\\coach\\OneDrive\\CoachBoard', lastCopiedAt: '2026-11-19T08:00:00.000Z', lastCopiedFile: 'coachboard-x.sqlite' }
const failing: MirrorStatus = { ...on, error: "The folder E:\\Backups can't be found. Is the drive plugged in, or was the folder moved?", failingSince: '2026-11-19T09:00:00.000Z' }

describe('Second backup folder in Settings', () => {
  it('is off until a folder is chosen, and says what the folder holds', async () => {
    serve({ '/api/backup/mirror': { body: off } })
    renderScreen(<BackupMirrorSection />)
    expect(await screen.findByText('Off')).toBeTruthy()
    expect(screen.getByText(/athletes’ data\. In a cloud folder, that service stores it too/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose folder/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Stop copying/ })).toBeNull()
  })

  it('choosing a folder shows it and when it was copied', async () => {
    const { calls } = serve({
      '/api/backup/mirror': { body: off },
      'POST /api/backup/mirror/pick': { body: { cancelled: false, status: on } },
    })
    renderScreen(<BackupMirrorSection />)
    await userEvent.click(await screen.findByRole('button', { name: /Choose folder/ }))
    expect(await screen.findByText(on.dir!)).toBeTruthy()
    expect(screen.getByText(/Last copied .* The 5 newest are kept there/)).toBeTruthy()
    expect(screen.getByText(/every backup is also copied there/)).toBeTruthy()
    expect(calls).toContain('POST /api/backup/mirror/pick')
  })

  it('cancelling the folder dialog changes nothing', async () => {
    serve({
      '/api/backup/mirror': { body: off },
      'POST /api/backup/mirror/pick': { body: { cancelled: true, status: off } },
    })
    renderScreen(<BackupMirrorSection />)
    await userEvent.click(await screen.findByRole('button', { name: /Choose folder/ }))
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.queryByText(/copied there/)).toBeNull()
  })

  it('a refused folder says why', async () => {
    serve({
      '/api/backup/mirror': { body: off },
      'POST /api/backup/mirror/pick': { status: 400, body: { error: "Choose a folder outside CoachBoard's own data folder." } },
    })
    renderScreen(<BackupMirrorSection />)
    await userEvent.click(await screen.findByRole('button', { name: /Choose folder/ }))
    expect(await screen.findByText(/outside CoachBoard's own data folder/)).toBeTruthy()
  })

  it('failing: says since when and why, and that the local backups go on', async () => {
    serve({ '/api/backup/mirror': { body: failing } })
    renderScreen(<BackupMirrorSection />)
    expect(await screen.findByText(/Not copied since .*can't be found.*The backups on this computer are still made/)).toBeTruthy()
  })

  it('stop copying', async () => {
    const { calls } = serve({ '/api/backup/mirror': { body: on }, 'DELETE /api/backup/mirror': { body: off } })
    renderScreen(<BackupMirrorSection />)
    await userEvent.click(await screen.findByRole('button', { name: /Stop copying/ }))
    expect(await screen.findByText(/copies already in that folder are left/)).toBeTruthy()
    expect(calls).toContain('DELETE /api/backup/mirror')
  })

  it('outside the app there is no folder dialog to open', async () => {
    serve({ '/api/backup/mirror': { body: { ...off, canPick: false } } })
    renderScreen(<BackupMirrorSection />)
    expect(await screen.findByText(/can be chosen in the CoachBoard app/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Choose folder/ })).toBeNull()
  })
})

function Alerting() { useBackupMirrorAlert(); return null }

describe('The one-time message when the copy fails (D93)', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => vi.useRealTimers())

  const after = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

  it('tells once per failure, not at every check or launch', async () => {
    const server = serve({ '/api/backup/mirror': { body: failing } })
    const first = renderScreen(<Alerting />)
    await after(5100)
    await waitFor(() => expect(screen.getAllByText(/not copied to your second folder/)).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy()
    // The next check, and a restart, say nothing new for the same failure.
    await after(16_000)
    await after(30 * 60 * 1000)
    expect(screen.queryAllByText(/not copied to your second folder/)).toHaveLength(0)
    first.unmount()
    renderScreen(<Alerting />)
    await after(5100)
    expect(screen.queryAllByText(/not copied to your second folder/)).toHaveLength(0)
    // It worked again, then failed anew: that is a new message.
    server.set('/api/backup/mirror', { body: { ...failing, failingSince: '2026-11-20T09:00:00.000Z' } })
    await after(30 * 60 * 1000)
    await waitFor(() => expect(screen.getAllByText(/not copied to your second folder/)).toHaveLength(1))
  })

  it('says nothing when it works or is off', async () => {
    serve({ '/api/backup/mirror': { body: on } })
    renderScreen(<Alerting />)
    await after(5100)
    expect(screen.queryByText(/not copied/)).toBeNull()
  })
})
