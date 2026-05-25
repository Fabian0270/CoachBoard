import { Router, Request, Response } from 'express'
import { db } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

const router = Router()

router.get('/', async (req: Request, res: Response): Promise<void> => {
  let query = db.selectFrom('programs').selectAll()
  if (req.query.athlete_id) {
    query = query.where('athlete_id', '=', req.query.athlete_id as string)
  }
  const programs = await query.orderBy('created_at', 'desc').execute()
  res.json(programs)
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const program = await db
    .selectFrom('programs')
    .selectAll()
    .where('id', '=', req.params.id)
    .executeTakeFirst()
  if (!program) {
    res.status(404).json({ error: 'Program not found' })
    return
  }
  const workouts = await db
    .selectFrom('workouts')
    .selectAll()
    .where('program_id', '=', req.params.id)
    .orderBy('scheduled_date')
    .execute()
  const workoutIds = workouts.map((w) => w.id)
  const exercises = workoutIds.length
    ? await db.selectFrom('exercises').selectAll().where('workout_id', 'in', workoutIds).orderBy('order_index').execute()
    : []
  res.json({ ...program, workouts: workouts.map((w) => ({ ...w, exercises: exercises.filter((e) => e.workout_id === w.id) })) })
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { athlete_id, name, description, start_date, end_date, status } = req.body
  if (!athlete_id || !name) {
    res.status(400).json({ error: 'athlete_id and name are required' })
    return
  }
  const now = new Date().toISOString()
  const program = await db
    .insertInto('programs')
    .values({ id: uuidv4(), athlete_id, name, description: description ?? null, start_date: start_date ?? null, end_date: end_date ?? null, status: status ?? 'active', created_at: now, updated_at: now })
    .returningAll()
    .executeTakeFirstOrThrow()
  res.status(201).json(program)
})

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { name, description, start_date, end_date, status } = req.body
  const updated = await db
    .updateTable('programs')
    .set({ name, description: description ?? null, start_date: start_date ?? null, end_date: end_date ?? null, status: status ?? 'active', updated_at: new Date().toISOString() })
    .where('id', '=', req.params.id)
    .returningAll()
    .executeTakeFirst()
  if (!updated) {
    res.status(404).json({ error: 'Program not found' })
    return
  }
  res.json(updated)
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const deleted = await db
    .deleteFrom('programs')
    .where('id', '=', req.params.id)
    .returningAll()
    .executeTakeFirst()
  if (!deleted) {
    res.status(404).json({ error: 'Program not found' })
    return
  }
  res.status(204).send()
})

router.post('/:programId/workouts', async (req: Request, res: Response): Promise<void> => {
  const { name, scheduled_date, notes } = req.body
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const workout = await db
    .insertInto('workouts')
    .values({ id: uuidv4(), program_id: req.params.programId, name, scheduled_date: scheduled_date ?? null, notes: notes ?? null, created_at: new Date().toISOString() })
    .returningAll()
    .executeTakeFirstOrThrow()
  res.status(201).json(workout)
})

router.post('/:programId/workouts/:workoutId/exercises', async (req: Request, res: Response): Promise<void> => {
  const { name, sets, reps, weight, duration, distance, notes, order_index } = req.body
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const exercise = await db
    .insertInto('exercises')
    .values({ id: uuidv4(), workout_id: req.params.workoutId, name, sets: sets ?? null, reps: reps ?? null, weight: weight ?? null, duration: duration ?? null, distance: distance ?? null, notes: notes ?? null, order_index: order_index ?? 0 })
    .returningAll()
    .executeTakeFirstOrThrow()
  res.status(201).json(exercise)
})

export default router
