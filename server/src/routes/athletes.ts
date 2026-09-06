import { Router, Request, Response } from 'express'
import { schemas, validate } from '../validation.js'
import {
  findAllAthletes,
  findAthleteById,
  createAthlete,
  updateAthlete,
  deleteAthlete,
  deleteAthleteKeepingPrograms,
  findMaxesByAthlete,
  createAthleteMax,
  deleteAthleteMax,
} from '../services/athleteService.js'
import { getAthleteMvts, setAthleteMvt } from '../services/athleteMvtService.js'
import { fail } from '../lib/httpError.js'

const router = Router()

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const includeArchived = req.query.include_archived === '1'
    res.json(await findAllAthletes({ includeArchived }))
  } catch (err) {
    fail(res, 'Failed to fetch athletes', err)
  }
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.json(athlete)
  } catch (err) {
    fail(res, 'Failed to fetch athlete', err)
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.athlete.create, req.body, res)
  if (!body) return
  try {
    res.status(201).json(await createAthlete(body))
  } catch (err) {
    fail(res, 'Failed to create athlete', err)
  }
})

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.athlete.update, req.body, res)
  if (!body) return
  try {
    const updated = await updateAthlete(String(req.params.id), body)
    if (!updated) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.json(updated)
  } catch (err) {
    fail(res, 'Failed to update athlete', err)
  }
})

// keep_programs=1 detaches + archives the athlete's programs instead of
// cascade-deleting them, so they can be reused with another athlete later.
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const keepPrograms = req.query.keep_programs === '1'
    const deleted = keepPrograms
      ? await deleteAthleteKeepingPrograms(String(req.params.id))
      : await deleteAthlete(String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.status(204).send()
  } catch (err) {
    fail(res, 'Failed to delete athlete', err)
  }
})

// ---------------------------------------------------------------------------
// Maxes (PRs)
// ---------------------------------------------------------------------------

/**
 * The athlete's own measured 1RM bar speeds, keyed by lift.
 *
 * Returned as a map rather than a list: the bar-path panel needs exactly one
 * lookup by lift, and a list would make every caller do the same reduce.
 */
router.get('/:id/mvt', async (req: Request, res: Response): Promise<void> => {
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.json(await getAthleteMvts(athlete.id))
  } catch (err) {
    fail(res, 'Failed to fetch 1RM velocities', err)
  }
})

router.put('/:id/mvt', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.athleteMvt.set, req.body, res)
  if (!body) return
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    await setAthleteMvt(athlete.id, body.lift, body.velocity ?? null)
    res.json(await getAthleteMvts(athlete.id))
  } catch (err) {
    // A rejected value is the coach's typo, not a server fault.
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid velocity' })
  }
})

router.get('/:id/maxes', async (req: Request, res: Response): Promise<void> => {
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.json(await findMaxesByAthlete(athlete.id))
  } catch (err) {
    fail(res, 'Failed to fetch maxes', err)
  }
})

router.post('/:id/maxes', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.athleteMax.create, req.body, res)
  if (!body) return
  try {
    const athlete = await findAthleteById(String(req.params.id))
    if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return }
    res.status(201).json(await createAthleteMax({ athlete_id: athlete.id, ...body }))
  } catch (err) {
    fail(res, 'Failed to create max', err)
  }
})

router.delete('/:id/maxes/:maxId', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteAthleteMax(String(req.params.maxId), String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Max not found' }); return }
    res.status(204).send()
  } catch (err) {
    fail(res, 'Failed to delete max', err)
  }
})

export default router
