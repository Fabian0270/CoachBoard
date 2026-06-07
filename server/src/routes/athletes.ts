import { Router, Request, Response } from 'express'
import { getDb } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

const db = new Proxy({} as ReturnType<typeof getDb>, {
  get: (_t, p) => {
    const target = getDb()
    const val = Reflect.get(target, p)
    return typeof val === 'function' ? (val as Function).bind(target) : val
  },
})

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
