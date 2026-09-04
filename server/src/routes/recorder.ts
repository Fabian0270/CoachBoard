import { Router } from 'express'
import express from 'express'
import { z } from 'zod'
import { canCapture, listSources, setPendingSource } from '../services/captureService.js'
import {
  appendChunk,
  beginRecording,
  deleteRecording,
  finishRecording,
  recordingPath,
  statRecording,
} from '../services/recordingStore.js'
import { fail } from '../lib/httpError.js'
import { dmRecordingToAthlete } from '../services/discordSendService.js'
import {
  ATTACHMENT_TOO_BIG,
  MAX_ATTACHMENT_BYTES as MAX_EMAIL_BYTES,
  sendAttachmentEmail,
} from '../services/emailService.js'
import fsp from 'fs/promises'

const router = Router()

/** Dated, so a coach's downloads folder does not fill with `recording.webm`. */
function recordingFilename(): string {
  return `coachboard-${new Date().toISOString().slice(0, 10)}.webm`
}

/** The finished bytes, or null while it is still being written. */
async function readRecording(id: string): Promise<Buffer | null> {
  let abs: string | null = null
  try {
    abs = await recordingPath(id)
  } catch {
    return null
  }
  if (!abs) return null
  return fsp.readFile(abs)
}

/**
 * The source list for the recorder's own picker.
 *
 * Windows does not give Electron 33 a system picker, so without this the coach
 * gets whatever the primary screen happens to be showing. See captureService.
 */
router.get('/sources', async (_req, res) => {
  if (!canCapture()) {
    res.status(503).json({ error: 'Screen capture is only available in the desktop app' })
    return
  }
  res.json(await listSources())
})

const chooseSchema = z.object({ id: z.string().min(1).max(200) })

/**
 * Parks the coach's choice for the display-media handler in the main process to
 * pick up on the getDisplayMedia call that follows immediately after.
 */
router.post('/source', (req, res) => {
  const parsed = chooseSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid source' })
    return
  }
  if (!canCapture()) {
    res.status(503).json({ error: 'Screen capture is only available in the desktop app' })
    return
  }
  setPendingSource(parsed.data.id)
  res.json({ ok: true })
})

/** Abandoning the preflight must not leave a choice behind for a later capture. */
router.delete('/source', (_req, res) => {
  setPendingSource(null)
  res.json({ ok: true })
})

// --- Recordings -----------------------------------------------------------
//
// Registered after the literal /source paths above so :id cannot swallow them —
// Express matches in order. Same ordering trap as routes/discord.ts.

router.post('/recordings', async (_req, res) => {
  try {
    res.json({ id: await beginRecording() })
  } catch (err) {
    fail(res, 'Could not start the recording', err)
  }
})

/**
 * One MediaRecorder chunk.
 *
 * express.json() is global in app.ts and only parses application/json, so a raw
 * parser is mounted per-route for binary bodies — same shape as the thumbnail
 * upload in routes/discord.ts and the restore upload in routes/backup.ts. The
 * limit is generous because it bounds a single timeslice, not the recording.
 */
router.post(
  '/recordings/:id/chunk',
  express.raw({ type: 'video/webm', limit: '64mb' }),
  async (req, res) => {
    const body = req.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Expected a WebM body' })
      return
    }
    try {
      res.json({ bytes: await appendChunk(req.params.id, body) })
    } catch (err) {
      // A rejected chunk is the renderer's problem to know about immediately —
      // it is still recording, and every later chunk would fail the same way.
      res.status(400).json({ error: err instanceof Error ? err.message : 'Chunk rejected' })
    }
  },
)

router.post('/recordings/:id/finish', async (req, res) => {
  try {
    res.json(await finishRecording(req.params.id))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not finish' })
  }
})

router.get('/recordings/:id', async (req, res) => {
  const info = await statRecording(req.params.id)
  if (!info) {
    res.status(404).json({ error: 'No such recording' })
    return
  }
  res.json(info)
})

/**
 * Streams the finished file, for the review player and for save-to-PC.
 *
 * `?download=1` turns it into a browser download so the coach picks where it
 * lands — the same idiom as the program .xlsx export, and the reason no
 * showSaveDialog or IPC is needed for save-to-PC at all.
 */
router.get('/recordings/:id/file', async (req, res) => {
  let abs: string | null = null
  try {
    abs = await recordingPath(req.params.id)
  } catch {
    res.status(400).json({ error: 'Invalid recording id' })
    return
  }
  if (!abs) {
    res.status(404).json({ error: 'Recording is not ready' })
    return
  }
  if (req.query.download) {
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Disposition', `attachment; filename="coachboard-${stamp}.webm"`)
  }
  // sendFile handles Range/206 natively — required for seeking during review.
  res.sendFile(abs, { acceptRanges: true, headers: { 'Content-Type': 'video/webm' } })
})

const discordSchema = z.object({
  athleteId: z.string().min(1),
  message: z.string().max(2000).default(''),
})

/** DM the recording to an athlete's linked Discord account. */
router.post('/recordings/:id/discord', async (req, res) => {
  const parsed = discordSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' })
    return
  }
  const data = await readRecording(req.params.id)
  if (!data) {
    res.status(404).json({ error: 'Recording is not ready' })
    return
  }
  try {
    const sent = await dmRecordingToAthlete(parsed.data.athleteId, parsed.data.message, {
      filename: recordingFilename(),
      contentType: 'video/webm',
      data,
    })
    // A logged failure is still a 200 from the send service's point of view, but
    // the coach needs it as an error — their athlete did not get the video.
    if (sent.status === 'failed') {
      res.status(502).json({ error: sent.error ?? 'Discord rejected the message' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send' })
  }
})

const emailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().max(5000).default(''),
})

router.post('/recordings/:id/email', async (req, res) => {
  const parsed = emailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Check the address and subject' })
    return
  }
  const data = await readRecording(req.params.id)
  if (!data) {
    res.status(404).json({ error: 'Recording is not ready' })
    return
  }
  if (data.length > MAX_EMAIL_BYTES) {
    res.status(ATTACHMENT_TOO_BIG.status).json({ error: ATTACHMENT_TOO_BIG.error })
    return
  }
  const result = await sendAttachmentEmail({
    to: parsed.data.to,
    subject: parsed.data.subject,
    body: parsed.data.body,
    attachmentName: recordingFilename(),
    attachment: data,
  })
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, code: result.code })
    return
  }
  res.json({ ok: true })
})

router.delete('/recordings/:id', async (req, res) => {
  try {
    await deleteRecording(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, 'Could not delete the recording', err)
  }
})

export default router
