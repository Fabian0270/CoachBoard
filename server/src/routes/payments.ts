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

const router = Router()

// Dashboard reminders — registered before '/:id' so it isn't shadowed by it.
router.get('/alerts', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await getPaymentAlerts())
  } catch (err) {
    fail(res, 'Failed to fetch payment alerts', err)
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
