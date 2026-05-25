import { Router, Request, Response } from 'express'
import { db } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

const router = Router()

router.get('/', async (req: Request, res: Response): Promise<void> => {
  let query = db.selectFrom('progress_records').selectAll()
  if (req.query.athlete_id) {
    query = query.where('athlete_id', '=', req.query.athlete_id as string)
  }
  if (req.query.metric_name) {
    query = query.where('metric_name', '=', req.query.metric_name as string)
  }
  const records = await query.orderBy('recorded_at', 'desc').execute()
  res.json(records)
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { athlete_id, metric_name, value, unit, recorded_at, notes } = req.body
  if (!athlete_id || !metric_name || value === undefined) {
    res.status(400).json({ error: 'athlete_id, metric_name, and value are required' })
    return
  }
  const record = await db
    .insertInto('progress_records')
    .values({
      id: uuidv4(),
      athlete_id,
      metric_name,
      value: Number(value),
      unit: unit ?? null,
      recorded_at: recorded_at ?? new Date().toISOString(),
      notes: notes ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  res.status(201).json(record)
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
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
})

export default router
