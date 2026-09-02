import express, { Router, Request, Response } from 'express'
import { fail } from '../lib/httpError.js'
import {
  RestoreError,
  backupInfo,
  cancelPendingRestore,
  exportToBuffer,
  runStartupBackup,
  stageRestore,
} from '../services/backupService.js'

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

// GET /api/backup/export — the whole database as a downloadable file.
router.get('/export', async (_req: Request, res: Response): Promise<void> => {
  try {
    const buffer = await exportToBuffer()
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="coachboard-backup-${stamp}.sqlite"`)
    res.send(buffer)
  } catch (err) {
    fail(res, 'Failed to export the database', err)
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
    res.json({ path: dest })
  } catch (err) {
    fail(res, 'Failed to write a backup', err)
  }
})

// POST /api/backup/restore — stage an uploaded database. Applied at next launch,
// because SQLite holds the live file open for the whole session.
router.post(
  '/restore',
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  (req: Request, res: Response): void => {
    try {
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'No file was uploaded' })
        return
      }
      stageRestore(body)
      res.json({ restartRequired: true })
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

// DELETE /api/backup/restore — change your mind before restarting.
router.delete('/restore', (_req: Request, res: Response): void => {
  try {
    res.json({ cancelled: cancelPendingRestore() })
  } catch (err) {
    fail(res, 'Failed to cancel the restore', err)
  }
})

export default router
