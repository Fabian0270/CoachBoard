import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { computeStyleProfile, detectPatterns } from '../services/styleService.js'

const router = Router()

const focusQuery = z.enum(['hypertrophy', 'strength', 'peaking'])

// GET /api/style-profile/patterns — named periodization patterns the coach
// exhibits across ≥3 similar programs (Feature 5d). Empty array below threshold.
router.get('/patterns', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await detectPatterns())
  } catch {
    res.status(500).json({ error: 'Failed to detect patterns' })
  }
})

// GET /api/style-profile?focus=<goal?> — coach-wide style profile, optionally
// scoped to one training focus. Returns usable:false below the min sample size.
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    let focus: 'hypertrophy' | 'strength' | 'peaking' | undefined
    if (req.query.focus !== undefined) {
      const parsed = focusQuery.safeParse(req.query.focus)
      if (!parsed.success) { res.status(400).json({ error: 'Invalid focus' }); return }
      focus = parsed.data
    }
    res.json(await computeStyleProfile({ focus }))
  } catch {
    res.status(500).json({ error: 'Failed to compute style profile' })
  }
})

export default router
