import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  createPayment,
  findPayments,
  updatePayment,
  deletePayment,
  renewPayment,
  getPaymentAlerts,
} from './paymentService.js'
import { paymentStatus } from 'coachboard-shared/payments'
import type { Payment } from 'coachboard-shared'

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const athlete = await createAthlete({ name: 'Paying Lifter' })
  athleteId = athlete.id
})

// Minimal Payment for pure status-helper assertions.
function fakePayment(p: Partial<Payment>): Payment {
  return {
    id: 'x', athlete_id: 'a', amount: 800, currency: 'SEK',
    start_date: null, paid_through: '2026-06-30', paid: 0, paid_at: null, notes: null,
    created_at: '', updated_at: '', ...p,
  }
}

describe('paymentStatus helper', () => {
  const today = '2026-06-21'
  it('overdue when unpaid and paid_through has passed', () => {
    expect(paymentStatus(fakePayment({ paid: 0, paid_through: '2026-06-10' }), today)).toBe('overdue')
  })
  it('due_soon when unpaid and paid_through within a week', () => {
    expect(paymentStatus(fakePayment({ paid: 0, paid_through: '2026-06-25' }), today)).toBe('due_soon')
  })
  it('upcoming when unpaid and paid_through further out', () => {
    expect(paymentStatus(fakePayment({ paid: 0, paid_through: '2026-07-30' }), today)).toBe('upcoming')
  })
  it('paid when settled and coverage well ahead', () => {
    expect(paymentStatus(fakePayment({ paid: 1, paid_through: '2026-07-31' }), today)).toBe('paid')
  })
  it('expiring_soon when paid but coverage ends within a week', () => {
    expect(paymentStatus(fakePayment({ paid: 1, paid_through: '2026-06-25' }), today)).toBe('expiring_soon')
  })
})

describe('payment CRUD', () => {
  it('creates and lists payments for an athlete', async () => {
    await createPayment({ athlete_id: athleteId, amount: 800, currency: 'SEK', paid_through: '2026-06-30' })
    const list = await findPayments({ athlete_id: athleteId })
    expect(list.length).toBeGreaterThan(0)
    expect(list[0].currency).toBe('SEK')
    expect(list[0].paid).toBe(0)
  })

  it('marking paid stamps paid_at; marking unpaid clears it', async () => {
    const p = await createPayment({ athlete_id: athleteId, amount: 800, currency: 'USD', paid_through: '2026-07-31' })
    const paid = await updatePayment(p.id, { paid: true })
    expect(paid?.paid).toBe(1)
    expect(paid?.paid_at).not.toBeNull()
    const unpaid = await updatePayment(p.id, { paid: false })
    expect(unpaid?.paid).toBe(0)
    expect(unpaid?.paid_at).toBeNull()
  })

  it('renew clones the next month, unpaid, shifting both dates', async () => {
    const p = await createPayment({
      athlete_id: athleteId, amount: 800, currency: 'EUR',
      start_date: '2026-06-01', paid_through: '2026-06-30', paid: true,
    })
    const next = await renewPayment(p.id)
    expect(next?.start_date).toBe('2026-07-01')
    expect(next?.paid_through).toBe('2026-07-30')
    expect(next?.paid).toBe(0)
    expect(next?.amount).toBe(800)
    expect(next?.currency).toBe('EUR')
  })

  it('deletes a payment', async () => {
    const p = await createPayment({ athlete_id: athleteId, amount: 1, currency: 'SEK', paid_through: '2026-06-30' })
    await deletePayment(p.id)
    const found = await getDb().selectFrom('payments').selectAll().where('id', '=', p.id).executeTakeFirst()
    expect(found).toBeUndefined()
  })

  it('update/delete/renew return undefined for a missing id', async () => {
    expect(await updatePayment('missing', { amount: 5 })).toBeUndefined()
    expect(await deletePayment('missing')).toBeUndefined()
    expect(await renewPayment('missing')).toBeUndefined()
  })
})

describe('getPaymentAlerts', () => {
  it('returns one most-urgent-first alert per athlete for the latest period needing attention', async () => {
    const a1 = await createAthlete({ name: 'Overdue Owen' })
    const a2 = await createAthlete({ name: 'Soon Sara' })
    const a3 = await createAthlete({ name: 'Fine Fred' })
    const today = '2026-06-21'

    // a1: an old paid period + a latest unpaid overdue one → overdue wins (latest).
    await createPayment({ athlete_id: a1.id, amount: 800, currency: 'SEK', paid_through: '2026-05-31', paid: true })
    await createPayment({ athlete_id: a1.id, amount: 800, currency: 'SEK', paid_through: '2026-06-10' })
    // a2: paid but coverage expiring within the week.
    await createPayment({ athlete_id: a2.id, amount: 50, currency: 'USD', paid_through: '2026-06-25', paid: true })
    // a3: paid and comfortably ahead → no alert.
    await createPayment({ athlete_id: a3.id, amount: 50, currency: 'USD', paid_through: '2026-12-31', paid: true })

    const alerts = await getPaymentAlerts(today)
    const byId = new Map(alerts.map((al) => [al.athleteId, al]))

    expect(byId.get(a1.id)?.status).toBe('overdue')
    expect(byId.get(a2.id)?.status).toBe('expiring_soon')
    expect(byId.has(a3.id)).toBe(false)
    // Most-urgent first: overdue before expiring_soon.
    const order = alerts.map((al) => al.status)
    expect(order.indexOf('overdue')).toBeLessThan(order.indexOf('expiring_soon'))
    // Exactly one alert per athlete.
    expect(new Set(alerts.map((al) => al.athleteId)).size).toBe(alerts.length)
  })
})
