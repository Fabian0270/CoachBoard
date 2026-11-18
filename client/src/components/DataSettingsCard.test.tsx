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

describe('Data settings — space used', () => {
  it('breaks the space down, with the Excel files counted inside the database', async () => {
    serve({
      ...paths,
      '/api/backup/info': { body: info() },
      '/api/system/storage': {
        body: {
          database: { bytes: 5 * 1024 * 1024, files: 1 },
          excelTemplates: { bytes: 2 * 1024 * 1024, files: 2 },
          backups: { bytes: 20 * 1024 * 1024, files: 5 },
          discordMedia: { bytes: 3 * 1024 ** 3, files: 120 },
          analysisVideos: { bytes: 0, files: 0 },
          totalBytes: 5 * 1024 * 1024 + 20 * 1024 * 1024 + 3 * 1024 ** 3,
        },
      },
    })
    renderScreen(<DataSettingsCard />)

    expect(await screen.findByText('5 MB — including 2 imported Excel files (2 MB)')).toBeTruthy()
    expect(screen.getByText('20 MB — 5 copies')).toBeTruthy()
    expect(screen.getByText('3 GB — 120 files')).toBeTruthy()
    expect(screen.getByText('0 B — 0 clips')).toBeTruthy()
    expect(screen.getByText('3 GB')).toBeTruthy()
  })

  it('falls back to the database size when the breakdown cannot be read', async () => {
    serve({ ...paths, '/api/backup/info': { body: info() }, '/api/system/storage': { status: 500, body: {} } })
    renderScreen(<DataSettingsCard />)
    expect(await screen.findByText('1 KB')).toBeTruthy()
  })
})

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
    expect(await screen.findByText('Automatic backups')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Undo last restore/ })).toBeNull()
  })
})
