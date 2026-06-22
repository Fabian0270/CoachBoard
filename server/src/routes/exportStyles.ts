import { Router, Request, Response } from 'express'
import { findAllExportStyles, deleteExportStyle } from '../services/exportStyleService.js'

// Reusable, opt-in saved export styles (the "save this program's style" library).
const router = Router()

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await findAllExportStyles())
  } catch {
    res.status(500).json({ error: 'Failed to fetch export styles' })
  }
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteExportStyle(String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Export style not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete export style' })
  }
})

export default router
