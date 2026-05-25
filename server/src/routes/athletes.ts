import { Router, Request, Response } from 'express'
import { db } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

const router = Router()

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const athletes = await db.selectFrom('athletes').selectAll().orderBy('name').execute()
  res.json(athletes)
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const athlete = await db
    .selectFrom('athletes')
    .selectAll()
    .where('id', '=', req.params.id)
    .executeTakeFirst()
  if (!athlete) {
    res.status(404).json({ error: 'Athlete not found' })
    return
  }
  res.json(athlete)
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { name, email, sport, date_of_birth, notes } = req.body
  if (!name) {
    res.status(400).json({ error: 'Name is required' })
    return
  }
  const now = new Date().toISOString()
  const athlete = await db
    .insertInto('athletes')
    .values({ id: uuidv4(), name, email: email ?? null, sport: sport ?? null, date_of_birth: date_of_birth ?? null, notes: notes ?? null, created_at: now, updated_at: now })
    .returningAll()
    .executeTakeFirstOrThrow()
  res.status(201).json(athlete)
})

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { name, email, sport, date_of_birth, notes } = req.body
  const updated = await db
    .updateTable('athletes')
    .set({ name, email: email ?? null, sport: sport ?? null, date_of_birth: date_of_birth ?? null, notes: notes ?? null, updated_at: new Date().toISOString() })
    .where('id', '=', req.params.id)
    .returningAll()
    .executeTakeFirst()
  if (!updated) {
    res.status(404).json({ error: 'Athlete not found' })
    return
  }
  res.json(updated)
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const deleted = await db
    .deleteFrom('athletes')
    .where('id', '=', req.params.id)
    .returningAll()
    .executeTakeFirst()
  if (!deleted) {
    res.status(404).json({ error: 'Athlete not found' })
    return
  }
  res.status(204).send()
})

export default router
