import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { validate } from '../validation.js'
import { fail } from '../lib/httpError.js'
import { canReveal, dataDir, databasePath, logFilePath, reveal } from '../services/systemService.js'

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

export default router
