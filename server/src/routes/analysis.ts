import { Router } from 'express'
import express from 'express'
import { z } from 'zod'
import { VBT_LIFTS } from 'coachboard-shared/vbt'
import {
  saveAnalysis,
  listAnalyses,
  getAnalysis,
  setAnalysisAthlete,
  deleteAnalysis,
  ownedVideoPath,
} from '../services/videoAnalysisService.js'
import { appendVideoChunk, beginVideo, finishVideo } from '../services/analysisVideoStore.js'
import { fail } from '../lib/httpError.js'

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
  metric: z.enum(['mean', 'peak', 'propulsive']).nullable().optional(),
  // Produced by POST /video, never composed by the client. Constrained to the
  // shape this server writes so a crafted body cannot point a row at some other
  // file — resolveMediaAbsPath would refuse an escape, but a row pointing at an
  // unrelated media file would still be wrong.
  videoPath: z
    .string()
    .regex(/^analyses\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/, 'Not a stored video path')
    .nullable()
    .optional(),
  videoBytes: z.number().int().positive().nullable().optional(),
})

router.get('/', async (req, res) => {
  const mediaId = typeof req.query.mediaId === 'string' ? req.query.mediaId : undefined
  const athleteId = typeof req.query.athleteId === 'string' ? req.query.athleteId : undefined
  // The velocity panel lists a whole history for its load and metrics only, and
  // the paths would dwarf everything else it needs.
  const withTrack = req.query.withTrack !== '0'
  res.json(await listAnalyses({ mediaId, athleteId, withTrack }))
})

// --- Keeping the footage ---------------------------------------------------
//
// Registered BEFORE '/:id' so the literal path wins: Express matches in order
// and ':id' would otherwise swallow '/video'. Same trap as routes/discord.ts.
//
// The upload is separate from the save because express.json() is global with a
// 100 kb default — a video cannot ride the save body — and chunked because a
// lift clip runs to hundreds of megabytes.

router.post('/video', async (req, res) => {
  const filename = typeof req.query.filename === 'string' ? req.query.filename : undefined
  try {
    res.json(await beginVideo(filename))
  } catch (err) {
    fail(res, 'Could not start the upload', err)
  }
})

router.post(
  '/video/:id/chunk',
  express.raw({ type: 'application/octet-stream', limit: '32mb' }),
  async (req, res) => {
    const ext = typeof req.query.ext === 'string' ? req.query.ext : ''
    const body = req.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Expected a video body' })
      return
    }
    try {
      res.json({ bytes: await appendVideoChunk(req.params.id, ext, body) })
    } catch (err) {
      // The renderer is still uploading, so it needs to know now — every later
      // chunk would fail the same way.
      res.status(400).json({ error: err instanceof Error ? err.message : 'Chunk rejected' })
    }
  },
)

router.post('/video/:id/finish', async (req, res) => {
  const ext = typeof req.query.ext === 'string' ? req.query.ext : ''
  try {
    res.json(await finishVideo(req.params.id, ext))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not finish' })
  }
})

/**
 * Plays a saved analysis back.
 *
 * One route for both kinds of ownership, so the client never has to know which
 * it is looking at: a local import streams the analysis's own copy, a Discord
 * clip redirects to the media route that already serves the synced file.
 */
router.get('/:id/video', async (req, res) => {
  const found = await getAnalysis(req.params.id)
  if (!found) {
    res.status(404).json({ error: 'Analysis not found' })
    return
  }
  const owned = await ownedVideoPath(req.params.id)
  if (owned) {
    // sendFile handles Range/206 natively — required for seeking.
    res.sendFile(owned, { acceptRanges: true, headers: { 'Content-Type': 'video/mp4' } })
    return
  }
  if (found.mediaId) {
    res.redirect(`/api/discord/media/${found.mediaId}/file`)
    return
  }
  res.status(404).json({ error: 'No video kept for this analysis' })
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
      metric: parsed.data.metric ?? null,
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
