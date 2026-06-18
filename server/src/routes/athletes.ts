import { Router, Request, Response } from 'express'
import { schemas, validate } from '../validation.js'
import {
  findAllAthletes,
  findAthleteById,
  createAthlete,
  updateAthlete,
  deleteAthlete,
  findMaxesByAthlete,
  createAthleteMax,
  deleteAthleteMax,
} from '../services/athleteService.js'

const router = Router()

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const includeArchived = req.query.include_archived === '1'
    res.json(await findAllAthletes({ includeArchived }))
  } catch {
    res.status(500).json({ error: 'Failed to fetch athletes' })
  }
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.json(athlete)
  } catch {
    res.status(500).json({ error: 'Failed to fetch athlete' })
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.athlete.create, req.body, res)
  if (!body) return
  try {
    res.status(201).json(await createAthlete(body))
  } catch {
    res.status(500).json({ error: 'Failed to create athlete' })
  }
})

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.athlete.update, req.body, res)
  if (!body) return
  try {
    const updated = await updateAthlete(String(req.params.id), body)
    if (!updated) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Failed to update athlete' })
  }
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteAthlete(String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete athlete' })
  }
})

// ---------------------------------------------------------------------------
// Maxes (PRs)
// ---------------------------------------------------------------------------

router.get('/:id/maxes', async (req: Request, res: Response): Promise<void> => {
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.json(await findMaxesByAthlete(athlete.id))
  } catch {
    res.status(500).json({ error: 'Failed to fetch maxes' })
  }
})

router.post('/:id/maxes', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.athleteMax.create, req.body, res)
  if (!body) return
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.status(201).json(await createAthleteMax({ athlete_id: athlete.id, ...body }))
  } catch {
    res.status(500).json({ error: 'Failed to create max' })
  }
})

router.delete('/:id/maxes/:maxId', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteAthleteMax(String(req.params.maxId), String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Max not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete max' })
  }
})

export default router
