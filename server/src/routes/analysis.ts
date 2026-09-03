import { Router } from 'express'
import { z } from 'zod'
import {
  saveAnalysis,
  listAnalyses,
  getAnalysis,
  deleteAnalysis,
} from '../services/videoAnalysisService.js'

const router = Router()

const pointSchema = z.object({ x: z.number(), y: z.number() })

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
})

router.get('/', async (req, res) => {
  const mediaId = typeof req.query.mediaId === 'string' ? req.query.mediaId : undefined
  const athleteId = typeof req.query.athleteId === 'string' ? req.query.athleteId : undefined
  res.json(await listAnalyses({ mediaId, athleteId }))
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
      // Metrics are a cache of what the client already computed; they are
      // displayed, never recomputed from, so the loose shape is fine here.
      metrics: parsed.data.metrics as never,
    }),
  )
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
