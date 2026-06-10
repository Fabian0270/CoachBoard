import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { db } from './db-proxy.js'

const router = Router()

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    let query = db.selectFrom('progress_records').selectAll()
    if (req.query.athlete_id) {
      query = query.where('athlete_id', '=', req.query.athlete_id as string)
    }
    if (req.query.metric_name) {
      query = query.where('metric_name', '=', req.query.metric_name as string)
    }
    const records = await query.orderBy('recorded_at', 'desc').execute()
    res.json(records)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progress records' })
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { athlete_id, metric_name, value, unit, recorded_at, notes } = req.body
  if (!athlete_id || !metric_name || value === undefined) {
    res.status(400).json({ error: 'athlete_id, metric_name, and value are required' })
    return
  }
  const numericValue = Number(value)
  if (isNaN(numericValue)) {
    res.status(400).json({ error: 'value must be a number' })
    return
  }
  try {
    const record = await db
      .insertInto('progress_records')
      .values({
        id: uuidv4(),
        athlete_id,
        metric_name,
        value: numericValue,
        unit: unit ?? null,
        recorded_at: recorded_at ?? new Date().toISOString(),
        notes: notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    res.status(201).json(record)
  } catch (err) {
    res.status(500).json({ error: 'Failed to create progress record' })
  }
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await db
      .deleteFrom('progress_records')
      .where('id', '=', req.params.id)
      .returningAll()
      .executeTakeFirst()
    if (!deleted) {
      res.status(404).json({ error: 'Record not found' })
      return
    }
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete progress record' })
  }
})

export default router
