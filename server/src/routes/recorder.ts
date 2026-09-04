import { Router } from 'express'
import { z } from 'zod'
import { canCapture, listSources, setPendingSource } from '../services/captureService.js'

const router = Router()

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

export default router
