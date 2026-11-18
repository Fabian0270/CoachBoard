import { Router } from 'express'
import { z } from 'zod'
import { getSettings, saveSettings, EmailSettingsError } from '../services/emailSettingsService.js'
import { sendTestEmail } from '../services/emailService.js'
import { getDefaultUnit, setDefaultUnit } from '../services/unitService.js'
import { getPreferences, setPreferences } from '../services/preferencesService.js'
import { homeCurrency, setHomeCurrency } from '../services/ratesService.js'

const router = Router()

const emailSettingsSchema = z.object({
  provider: z.enum(['gmail', 'outlook', 'custom']),
  host: z.string().trim().min(1, 'SMTP host is required'),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().email('A valid email address is required'),
  fromName: z.string().trim().max(100).optional().default(''),
  // Optional on update — omit/empty keeps the previously-saved password.
  password: z.string().optional(),
})

// Returns the coach's email config without the password (only `configured`).
router.get('/email', async (_req, res) => {
  const settings = await getSettings()
  res.json(settings ?? { configured: false })
})

router.put('/email', async (req, res) => {
  const parsed = emailSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' })
    return
  }
  try {
    const saved = await saveSettings(parsed.data)
    res.json(saved)
  } catch (err) {
    if (err instanceof EmailSettingsError) {
      res.status(400).json({ error: err.message })
      return
    }
    res.status(500).json({ error: 'Failed to save email settings' })
  }
})

// The unit new athletes start with (S3, D78).
router.get('/units', async (_req, res) => {
  res.json({ defaultUnit: await getDefaultUnit() })
})

router.put('/units', async (req, res) => {
  const parsed = z.object({ defaultUnit: z.enum(['kg', 'lb']) }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'kg or lb' })
    return
  }
  await setDefaultUnit(parsed.data.defaultUnit)
  res.json({ defaultUnit: await getDefaultUnit() })
})

// The coach's own currency (S5, D84) — the same setting the Payments page's
// Revenue card changes, so the two always agree.
router.get('/currency', async (_req, res) => {
  res.json({ home: await homeCurrency() })
})

router.put('/currency', async (req, res) => {
  const parsed = z.object({ home: z.string().trim().regex(/^[A-Za-z]{3}$/, 'A three-letter currency code, like SEK') }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid currency' })
    return
  }
  await setHomeCurrency(parsed.data.home)
  res.json({ home: await homeCurrency() })
})

// Switches such as the day editor's suggested loads.
router.get('/preferences', async (_req, res) => {
  res.json(await getPreferences())
})

router.put('/preferences', async (req, res) => {
  const parsed = z.object({ loadHints: z.boolean().optional() }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid preferences' })
    return
  }
  res.json(await setPreferences(parsed.data))
})

router.post('/email/test', async (_req, res) => {
  const result = await sendTestEmail()
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, code: result.code })
    return
  }
  res.json({ ok: true })
})

export default router
