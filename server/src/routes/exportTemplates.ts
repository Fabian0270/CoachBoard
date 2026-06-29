import { Router, Request, Response } from 'express'
import { BUILTIN_EXPORT_TEMPLATES } from 'coachboard-shared/exportLayout'
import { buildTemplateSamplePreviewHtml, TemplatePreviewError } from '../services/templatePreview.js'

// Built-in starter templates: the list a coach picks from, and a sample-data HTML
// preview of each so they can see the look before choosing.
const router = Router()

router.get('/', (_req: Request, res: Response): void => {
  res.json(BUILTIN_EXPORT_TEMPLATES)
})

router.get('/:id/preview', async (req: Request, res: Response): Promise<void> => {
  try {
    const html = await buildTemplateSamplePreviewHtml(String(req.params.id))
    res.json({ html })
  } catch (err) {
    if (err instanceof TemplatePreviewError) {
      res.status(404).json({ error: err.message })
      return
    }
    res.status(500).json({ error: 'Failed to build the template preview' })
  }
})

export default router
