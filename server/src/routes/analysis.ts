import { Router } from 'express'
import { z } from 'zod'
import { VBT_LIFTS } from 'coachboard-shared/vbt'
import {
  saveAnalysis,
  listAnalyses,
  getAnalysis,
  setAnalysisAthlete,
  deleteAnalysis,
} from '../services/videoAnalysisService.js'

const router = Router()

const pointSchema = z.object({ x: z.number(), y: z.number() })

// Derived from the lift table rather than restated, so a lift added there cannot
// be silently rejected here.
const VBT_LIFT_IDS = VBT_LIFTS.map((l) => l.id) as [string, ...string[]]

const saveSchema = z.object({
  mediaId: z.string().nullable(),
  athleteId: z.string().nullable(),
  sourceLabel: z.string().max(300),
  // A tracked path is a few hundred points; the cap is generous but stops a
  // malformed client filling the database with one row.
  track: z
    .array(z.object({ t: z.number(), x: z.number(), y: z.number() }))
    .min(2)
    .max(20000),
  calibration: z
    .object({ a: pointSchema, b: pointSchema, plateDiameterMm: z.number().positive() })
    .nullable(),
  metrics: z.array(z.record(z.string(), z.unknown())).max(200),
  notes: z.string().max(2000).nullable(),
  // What the set was. Optional rather than nullable-and-required so an older
  // client — or the retention fixture in the tests — keeps posting successfully.
  lift: z.enum(VBT_LIFT_IDS).nullable().optional(),
  loadKg: z.number().positive().max(1000).nullable().optional(),
  // Half steps on the 5-10 scale, matching RPE_VALUES in shared/rpe.ts.
  calledRpe: z
    .number()
    .min(5)
    .max(10)
    .refine((v) => Number.isInteger(v * 2), 'RPE must be a half step')
    .nullable()
    .optional(),
})

router.get('/', async (req, res) => {
  const mediaId = typeof req.query.mediaId === 'string' ? req.query.mediaId : undefined
  const athleteId = typeof req.query.athleteId === 'string' ? req.query.athleteId : undefined
  // The velocity panel lists a whole history for its load and metrics only, and
  // the paths would dwarf everything else it needs.
  const withTrack = req.query.withTrack !== '0'
  res.json(await listAnalyses({ mediaId, athleteId, withTrack }))
})

router.get('/:id', async (req, res) => {
  const found = await getAnalysis(req.params.id)
  if (!found) {
    res.status(404).json({ error: 'Analysis not found' })
    return
  }
  res.json(found)
})

router.post('/', async (req, res) => {
  const parsed = saveSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid analysis' })
    return
  }
  res.status(201).json(
    await saveAnalysis({
      ...parsed.data,
      lift: parsed.data.lift ?? null,
      loadKg: parsed.data.loadKg ?? null,
      calledRpe: parsed.data.calledRpe ?? null,
      // Metrics are a cache of what the client already computed; they are
      // displayed, never recomputed from, so the loose shape is fine here.
      metrics: parsed.data.metrics as never,
    }),
  )
})

// Attaching an athlete after the fact. Deliberately the only mutable field: the
// path and its metrics are a measurement, and editing those would make a saved
// analysis something other than what was tracked.
const attachSchema = z.object({ athleteId: z.string().nullable() })

router.patch('/:id', async (req, res) => {
  const parsed = attachSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid athlete' })
    return
  }
  const updated = await setAnalysisAthlete(req.params.id, parsed.data.athleteId)
  if (!updated) {
    res.status(404).json({ error: 'Analysis not found' })
    return
  }
  res.json(updated)
})

router.delete('/:id', async (req, res) => {
  const deleted = await deleteAnalysis(req.params.id)
  if (!deleted) {
    res.status(404).json({ error: 'Analysis not found' })
    return
  }
  res.json({ ok: true })
})

export default router
