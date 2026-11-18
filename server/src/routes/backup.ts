import express, { Router, Request, Response } from 'express'
import { fail } from '../lib/httpError.js'
import {
  RestoreError,
  backupInfo,
  cancelPendingRestore,
  dismissRestoreFailure,
  exportToBuffer,
  mirrorCopyDone,
  newestBackupPath,
  runStartupBackup,
  stageRestore,
  stageUndoRestore,
} from '../services/backupService.js'
import {
  MirrorError,
  clearMirrorDir,
  mirrorStatus,
  pickMirrorFolder,
  setMirrorDir,
} from '../services/backupMirrorService.js'

const router = Router()

// GET /api/backup/info — database location/size and rolling-backup state, so the
// Settings screen can answer "where is my data and is it backed up?".
router.get('/info', (_req: Request, res: Response): void => {
  try {
    res.json(backupInfo())
  } catch (err) {
    fail(res, 'Failed to read backup status', err)
  }
})

// GET /api/backup/export — a full backup archive (database + settings) as a
// downloadable file. See the format note in backupService.
router.get('/export', async (_req: Request, res: Response): Promise<void> => {
  try {
    const buffer = await exportToBuffer()
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="coachboard-backup-${stamp}.zip"`)
    res.send(buffer)
  } catch (err) {
    fail(res, 'Failed to export your data', err)
  }
})

// POST /api/backup/now — take a rolling backup on demand, same as the launch one.
router.post('/now', async (_req: Request, res: Response): Promise<void> => {
  try {
    const dest = await runStartupBackup()
    if (!dest) {
      res.status(503).json({ error: 'Backups are not available in this environment' })
      return
    }
    // Pressed by the coach, so wait for the second folder too and say how it went.
    await mirrorCopyDone()
    res.json({ path: dest, mirror: mirrorStatus() })
  } catch (err) {
    fail(res, 'Failed to write a backup', err)
  }
})

// ── The second backup folder (N4) ────────────────────────────────────────
// No route takes a path from the page: the folder comes from the system's own
// "choose a folder" dialog, so the page cannot point CoachBoard at any path.

// GET /api/backup/mirror — the folder, when it last worked, and why not if not.
router.get('/mirror', (_req: Request, res: Response): void => {
  try {
    res.json(mirrorStatus())
  } catch (err) {
    fail(res, 'Failed to read the second backup folder', err)
  }
})

// POST /api/backup/mirror/pick — open the folder dialog; start copying there.
router.post('/mirror/pick', async (_req: Request, res: Response): Promise<void> => {
  try {
    const dir = await pickMirrorFolder()
    if (!dir) {
      res.json({ cancelled: true, status: mirrorStatus() })
      return
    }
    res.json({ cancelled: false, status: await setMirrorDir(dir, newestBackupPath()) })
  } catch (err) {
    if (err instanceof MirrorError) {
      res.status(400).json({ error: err.message })
      return
    }
    fail(res, 'Failed to set the second backup folder', err)
  }
})

// DELETE /api/backup/mirror — stop copying; what is already there stays.
router.delete('/mirror', (_req: Request, res: Response): void => {
  try {
    res.json(clearMirrorDir())
  } catch (err) {
    fail(res, 'Failed to stop the second backup folder', err)
  }
})

// POST /api/backup/restore — stage an uploaded backup. Applied at next launch,
// because SQLite holds the live file open for the whole session. Accepts both
// the current .zip archive and a bare .sqlite from before that format existed.
router.post(
  '/restore',
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'No file was uploaded' })
        return
      }
      const staged = await stageRestore(body)
      // The client tells the coach which parts are coming back, so a database-only
      // restore does not look like it will bring their email settings with it.
      res.json({ restartRequired: true, settings: staged.settings })
    } catch (err) {
      // A rejected file is the coach's problem to fix, not a server fault — give
      // them the specific reason rather than a generic 500.
      if (err instanceof RestoreError) {
        res.status(400).json({ error: err.message })
        return
      }
      fail(res, 'Failed to stage the restore', err)
    }
  },
)

// POST /api/backup/restore/undo — go back to the database the last restore
// replaced. Applied at next launch, exactly like a restore.
router.post('/restore/undo', (_req: Request, res: Response): void => {
  try {
    const staged = stageUndoRestore()
    res.json({ restartRequired: true, settings: staged.settings })
  } catch (err) {
    if (err instanceof RestoreError) {
      res.status(400).json({ error: err.message })
      return
    }
    fail(res, 'Failed to stage the undo', err)
  }
})

// DELETE /api/backup/restore-failed — dismiss the notice about a rolled-back restore.
router.delete('/restore-failed', (_req: Request, res: Response): void => {
  try {
    dismissRestoreFailure()
    res.status(204).end()
  } catch (err) {
    fail(res, 'Failed to dismiss the notice', err)
  }
})

// DELETE /api/backup/restore — change your mind before restarting.
router.delete('/restore', (_req: Request, res: Response): void => {
  try {
    res.json({ cancelled: cancelPendingRestore() })
  } catch (err) {
    fail(res, 'Failed to cancel the restore', err)
  }
})

export default router
