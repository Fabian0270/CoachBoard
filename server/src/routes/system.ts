import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { validate } from '../validation.js'
import { fail } from '../lib/httpError.js'
import { canReveal, dataDir, databasePath, logFilePath, reveal } from '../services/systemService.js'
import { getUpdateState, installUpdate } from '../services/updateService.js'

const router = Router()

// GET /api/system/paths — where the app keeps the coach's data. Surfaced in the
// error screen and Settings so "where is my data?" has an answer in the app
// rather than only in the README.
router.get('/paths', (_req: Request, res: Response): void => {
  try {
    res.json({
      dataDir: dataDir(),
      databasePath: databasePath(),
      logPath: logFilePath(),
      canReveal: canReveal(),
    })
  } catch (err) {
    fail(res, 'Failed to read system paths', err)
  }
})

const revealBody = z.object({ target: z.enum(['data', 'logs']) })

// POST /api/system/reveal — open the data folder in the OS file manager.
// Named targets only; see the note in systemService.reveal.
router.post('/reveal', async (req: Request, res: Response): Promise<void> => {
  const body = validate(revealBody, req.body, res)
  if (!body) return
  try {
    const opened = await reveal(body.target)
    if (!opened) {
      res.status(503).json({ error: 'Not available outside the desktop app' })
      return
    }
    res.status(204).end()
  } catch (err) {
    fail(res, 'Failed to open the data folder', err)
  }
})

// GET /api/system/update — auto-update status, polled by the UI so a downloaded
// update can offer a restart. Always answers, even when updates are unsupported
// on this platform, so the client needs no special-casing.
router.get('/update', (_req: Request, res: Response): void => {
  try {
    res.json(getUpdateState())
  } catch (err) {
    fail(res, 'Failed to read update status', err)
  }
})

// POST /api/system/update/install — quit and install a downloaded update.
router.post('/update/install', (_req: Request, res: Response): void => {
  try {
    if (!installUpdate()) {
      res.status(409).json({ error: 'No update is ready to install' })
      return
    }
    res.status(202).end()
  } catch (err) {
    fail(res, 'Failed to install the update', err)
  }
})

export default router
