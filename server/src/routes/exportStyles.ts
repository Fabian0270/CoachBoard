import { Router, Request, Response } from 'express'
import { findAllExportStyles, renameExportStyle, deleteExportStyle } from '../services/exportStyleService.js'

// Reusable, opt-in saved export styles (the "save this program's style" library).
const router = Router()

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await findAllExportStyles())
  } catch {
    res.status(500).json({ error: 'Failed to fetch export styles' })
  }
})

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  if (!name || name.length > 100) { res.status(400).json({ error: 'name must be 1–100 characters' }); return }
  try {
    const renamed = await renameExportStyle(String(req.params.id), name)
    if (!renamed) { res.status(404).json({ error: 'Export style not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to rename export style' })
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
