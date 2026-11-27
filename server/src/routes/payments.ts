import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { schemas, validate } from '../validation.js'
import {
  findPayments,
  createPayment,
  updatePayment,
  deletePayment,
  renewPayment,
  getPaymentAlerts,
} from '../services/paymentService.js'
import { fail } from '../lib/httpError.js'
import { paymentsCsv, revenueSummary } from '../services/revenueService.js'
import { setHomeCurrency, setManualRates } from '../services/ratesService.js'
import { reminderDraft, sendReminder, ReminderError } from '../services/paymentReminderService.js'

const router = Router()

// Dashboard reminders — registered before '/:id' so it isn't shadowed by it.
router.get('/alerts', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await getPaymentAlerts())
  } catch (err) {
    fail(res, 'Failed to fetch payment alerts', err)
  }
})

// --- Revenue (S5, D84–D86) — before '/:id' too. -----------------------------

// ?basis=covered spreads payments over the months they cover; the default
// counts them in the month they were paid (D86).
router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await revenueSummary({ basis: req.query.basis === 'covered' ? 'covered' : 'paid' }))
  } catch (err) {
    fail(res, 'Failed to work out the revenue', err)
  }
})

router.put('/currency', async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({ home: z.string().trim().min(1).max(10) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Which currency?' }); return }
  try {
    await setHomeCurrency(parsed.data.home)
    res.json(await revenueSummary({ basis: req.query.basis === 'covered' ? 'covered' : 'paid' }))
  } catch (err) {
    fail(res, 'Failed to save the currency', err)
  }
})

router.put('/rates', async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({ rates: z.record(z.string().trim().min(1).max(10), z.number().positive().max(1e7)) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Rates must be positive numbers' }); return }
  try {
    await setManualRates(parsed.data.rates)
    res.json(await revenueSummary({ basis: req.query.basis === 'covered' ? 'covered' : 'paid' }))
  } catch (err) {
    fail(res, 'Failed to save the rates', err)
  }
})

router.get('/export.csv', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="coachboard-payments.csv"')
    res.send(await paymentsCsv())
  } catch (err) {
    fail(res, 'Failed to export the payments', err)
  }
})

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters: { athlete_id?: string } = {}
    if (req.query.athlete_id !== undefined) {
      const parsed = z.uuid().safeParse(req.query.athlete_id)
      if (!parsed.success) { res.status(400).json({ error: 'Invalid athlete_id' }); return }
      filters.athlete_id = parsed.data
    }
    res.json(await findPayments(filters))
  } catch (err) {
    fail(res, 'Failed to fetch payments', err)
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.payment.create, req.body, res)
  if (!body) return
  try {
    res.status(201).json(await createPayment(body))
  } catch (err) {
    fail(res, 'Failed to create payment', err)
  }
})

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.payment.update, req.body, res)
  if (!body) return
  try {
    const updated = await updatePayment(String(req.params.id), body)
    if (!updated) { res.status(404).json({ error: 'Payment not found' }); return }
    res.json(updated)
  } catch (err) {
    fail(res, 'Failed to update payment', err)
  }
})

// --- Reminders (S5, D87): a draft, then sent only on the coach's click. ------

router.get('/:id/reminder', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await reminderDraft(String(req.params.id)))
  } catch (err) {
    if (err instanceof ReminderError) { res.status(err.status).json({ error: err.message }); return }
    fail(res, 'Failed to prepare the reminder', err)
  }
})

const reminderSchema = z.object({ subject: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(5000) })

router.post('/:id/reminder', async (req: Request, res: Response): Promise<void> => {
  const parsed = reminderSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Write a subject and a message' }); return }
  try {
    const result = await sendReminder(String(req.params.id), parsed.data)
    if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return }
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof ReminderError) { res.status(err.status).json({ error: err.message }); return }
    fail(res, 'Failed to send the reminder', err)
  }
})

router.post('/:id/renew', async (req: Request, res: Response): Promise<void> => {
  try {
    const next = await renewPayment(String(req.params.id))
    if (!next) { res.status(404).json({ error: 'Payment not found' }); return }
    res.status(201).json(next)
  } catch (err) {
    fail(res, 'Failed to renew payment', err)
  }
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deletePayment(String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Payment not found' }); return }
    res.status(204).send()
  } catch (err) {
    fail(res, 'Failed to delete payment', err)
  }
})

export default router
