import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { needsAttention } from '../services/attentionService.js'
import { fail } from '../lib/httpError.js'

const router = Router()

// The dashboard's "needs attention" list. `today` is the coach's local date.
router.get('/attention', async (req: Request, res: Response): Promise<void> => {
  const today = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(req.query.today)
  if (!today.success) { res.status(400).json({ error: 'today must be a date (YYYY-MM-DD)' }); return }
  try {
    res.json(await needsAttention(today.data))
  } catch (err) {
    fail(res, 'Failed to work out what needs attention', err)
  }
})

export default router
