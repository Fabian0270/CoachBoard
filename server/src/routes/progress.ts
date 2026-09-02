import { Router, Request, Response } from 'express'
import { schemas, validate } from '../validation.js'
import { z } from 'zod'
import {
  findProgressRecords,
  createProgressRecord,
  deleteProgressRecord,
} from '../services/progressService.js'
import { fail } from '../lib/httpError.js'

const router = Router()

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters: { athlete_id?: string; metric_name?: string } = {}

    if (req.query.athlete_id !== undefined) {
      const parsed = z.uuid().safeParse(req.query.athlete_id)
      if (!parsed.success) { res.status(400).json({ error: 'Invalid athlete_id' }); return }
      filters.athlete_id = parsed.data
    }

    if (req.query.metric_name !== undefined) {
      const parsed = z.string().min(1).max(100).safeParse(req.query.metric_name)
      if (!parsed.success) { res.status(400).json({ error: 'Invalid metric_name' }); return }
      filters.metric_name = parsed.data
    }

    res.json(await findProgressRecords(filters))
  } catch (err) {
    fail(res, 'Failed to fetch progress records', err)
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.progress.create, req.body, res)
  if (!body) return
  try {
    res.status(201).json(await createProgressRecord(body))
  } catch (err) {
    fail(res, 'Failed to create progress record', err)
  }
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteProgressRecord(String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Record not found' }); return }
    res.status(204).send()
  } catch (err) {
    fail(res, 'Failed to delete progress record', err)
  }
})

export default router
