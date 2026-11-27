import fs from 'fs'
import path from 'path'
import { Router, Request, Response } from 'express'
import { fail } from '../lib/httpError.js'
import {
  PhoneLinkError,
  claimPhoneClip,
  phoneClip,
  phoneLinkStatus,
  startPhoneLink,
  stopPhoneLink,
} from '../services/phoneLinkService.js'

// The computer's side of the phone link (BP41 part b). These are on the app's
// own server — this computer only; the phone talks to the separate listener in
// phoneLinkService and never to these.

const router = Router()

const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
}

// POST /api/phone-link — open the link (or keep the one open) and get its QR code.
router.post('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await startPhoneLink())
  } catch (err) {
    if (err instanceof PhoneLinkError) { res.status(400).json({ error: err.message }); return }
    fail(res, 'Failed to open the phone link', err)
  }
})

// GET /api/phone-link — whether a clip is arriving or has arrived.
router.get('/', (_req: Request, res: Response): void => {
  res.json(phoneLinkStatus())
})

// GET /api/phone-link/clip — the clip that arrived, for the analysis to open.
router.get('/clip', (_req: Request, res: Response): void => {
  const clip = phoneClip()
  if (!clip || !fs.existsSync(clip.file)) { res.status(404).json({ error: 'No clip has arrived' }); return }
  res.setHeader('Content-Type', VIDEO_TYPES[path.extname(clip.file).toLowerCase()] ?? 'application/octet-stream')
  res.setHeader('Content-Length', String(clip.bytes))
  fs.createReadStream(clip.file).pipe(res)
})

// POST /api/phone-link/claim — the analysis has the clip: delete it here, end the link.
router.post('/claim', (_req: Request, res: Response): void => {
  claimPhoneClip()
  res.json(phoneLinkStatus())
})

// DELETE /api/phone-link[?link=<id>] — close the link; an unopened clip is deleted.
// With an id, only that visit's link: a screen closing its own and no newer one.
router.delete('/', (req: Request, res: Response): void => {
  const id = typeof req.query.link === 'string' ? req.query.link : undefined
  res.json(stopPhoneLink(id))
})

export default router
