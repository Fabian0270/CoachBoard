import { Router, Request, Response } from 'express'
import { fail } from '../lib/httpError.js'
import { loadSampleAthlete, removeSampleAthlete, sampleStatus } from '../services/sampleService.js'

// The tour's sample athlete (T7, D9, D111): load it, see whether it is there,
// remove it with everything it owns.

const router = Router()

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try { res.json(await sampleStatus()) } catch (err) { fail(res, 'Failed to read the sample athlete', err) }
})

router.post('/', async (_req: Request, res: Response): Promise<void> => {
  try { res.json(await loadSampleAthlete()) } catch (err) { fail(res, 'Failed to load the sample athlete', err) }
})

router.delete('/', async (_req: Request, res: Response): Promise<void> => {
  try { res.json(await removeSampleAthlete()) } catch (err) { fail(res, 'Failed to remove the sample athlete', err) }
})

export default router
