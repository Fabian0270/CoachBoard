// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DataSettingsCard from './DataSettingsCard'
import { renderScreen, serve } from '../test/render'

const info = (extra: object = {}) => ({
  databasePath: 'C:/data/coachboard.sqlite', databaseBytes: 1024, backupDir: 'C:/data/backups',
  backupCount: 3, latestBackup: null, restorePending: false, canUndoRestore: false, restoreFailure: null,
  ...extra,
})
const paths = { '/api/system/paths': { body: { dataDir: 'C:/data', canReveal: false } } }

describe('Data settings — restores', () => {
  it('explains a restore that could not be used, and clears the notice on dismiss', async () => {
    const server = serve({
      ...paths,
      '/api/backup/info': { body: info({ restoreFailure: { at: '', message: 'the restored database is damaged', previousKept: true } }) },
      'DELETE /api/backup/restore-failed': { body: { ok: true } },
    })
    renderScreen(<DataSettingsCard />)

    expect(await screen.findByText(/the restored database is damaged/)).toBeTruthy()
    expect(screen.getByText(/Your previous data was put back/)).toBeTruthy()

    server.set('/api/backup/info', { body: info() })
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText(/could not be used/)).toBeNull())
    expect(server.calls).toContain('DELETE /api/backup/restore-failed')
  })

  it('asks before undoing a restore, and only then stages it', async () => {
    const server = serve({
      ...paths,
      '/api/backup/info': { body: info({ canUndoRestore: true }) },
      'POST /api/backup/restore/undo': { body: { ok: true } },
    })
    renderScreen(<DataSettingsCard />)

    await userEvent.click(await screen.findByRole('button', { name: /Undo last restore/ }))
    // Nothing is sent until the coach confirms.
    expect(await screen.findByText('Undo the last restore?')).toBeTruthy()
    expect(server.calls).not.toContain('POST /api/backup/restore/undo')

    await userEvent.click(screen.getByRole('button', { name: 'Undo restore' }))
    expect(await screen.findByText(/Close and reopen CoachBoard to apply it/)).toBeTruthy()
    expect(server.calls).toContain('POST /api/backup/restore/undo')
  })

  it('offers no undo when there is nothing to go back to', async () => {
    serve({ ...paths, '/api/backup/info': { body: info() } })
    renderScreen(<DataSettingsCard />)
    expect(await screen.findByText(/C:\/data\/backups|backups/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Undo last restore/ })).toBeNull()
  })
})
