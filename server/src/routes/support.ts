import { Router } from 'express'
import { z } from 'zod'
import { buildReport, reportPreview, sendReport } from '../services/problemReportService.js'
import { fail } from '../lib/httpError.js'

// ---------------------------------------------------------------------------
// "Report a problem" (S4). The optional failing import file travels base64 in
// the JSON body, so this router gets its own body limit (REPORT_JSON_LIMIT),
// mounted ahead of the global parser like the analysis router.
// ---------------------------------------------------------------------------

/** An Excel file the app could not import, base64-encoded: room for ~20 MB. */
export const REPORT_JSON_LIMIT = '30mb'

const router = Router()

const reportSchema = z.object({
  description: z.string().max(5000),
  file: z.object({ name: z.string().min(1).max(260), base64: z.string().max(28_000_000) }).nullable().optional(),
})

const toInput = (body: z.infer<typeof reportSchema>) => ({
  description: body.description,
  file: body.file ? { name: body.file.name, content: Buffer.from(body.file.base64, 'base64') } : null,
})

// What a report would contain, and where it would go.
router.get('/report', async (_req, res) => {
  try {
    res.json(await reportPreview())
  } catch (err) {
    fail(res, 'Could not prepare the report', err)
  }
})

// Email it to the support address over the coach's email setup.
router.post('/report/send', async (req, res) => {
  const parsed = reportSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid report' })
    return
  }
  try {
    const result = await sendReport(toInput(parsed.data))
    if (!result.ok) {
      res.status(result.status).json({ error: result.error, code: result.code })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    fail(res, 'Could not send the report', err)
  }
})

// The same report as a .zip, for the coach to save and send themselves.
router.post('/report/zip', async (req, res) => {
  const parsed = reportSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid report' })
    return
  }
  try {
    const { zip, name } = await buildReport(toInput(parsed.data))
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(zip)
  } catch (err) {
    fail(res, 'Could not build the report', err)
  }
})

export default router
