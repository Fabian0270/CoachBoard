import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { paymentStatus, paymentNeedsAttention } from 'coachboard-shared/payments'
import type { CreatePaymentBody, UpdatePaymentBody, Payment, PaymentAlert } from 'coachboard-shared'

// Today's date as YYYY-MM-DD in the server's local timezone.
export function todayIso(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Add `months` calendar months to a YYYY-MM-DD date, clamping the day to the
// target month's length (e.g. Jan 31 + 1 month → Feb 28). Used by renew().
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()
  base.setUTCDate(Math.min(d, lastDay))
  return base.toISOString().slice(0, 10)
}

export async function findPayments(filters: { athlete_id?: string }): Promise<Payment[]> {
  let query = getDb().selectFrom('payments').selectAll()
  if (filters.athlete_id) query = query.where('athlete_id', '=', filters.athlete_id)
  // Most recent period first.
  return query.orderBy('due_date', 'desc').execute()
}

export async function findPaymentById(id: string): Promise<Payment | undefined> {
  return getDb().selectFrom('payments').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function createPayment(data: CreatePaymentBody): Promise<Payment> {
  const now = new Date().toISOString()
  const paid = data.paid ?? false
  return getDb()
    .insertInto('payments')
    .values({
      id: uuidv4(),
      athlete_id: data.athlete_id,
      amount: data.amount,
      currency: data.currency,
      period_start: data.period_start ?? null,
      period_end: data.period_end ?? null,
      due_date: data.due_date,
      paid: paid ? 1 : 0,
      // Default paid_at to today when marked paid on creation without an explicit date.
      paid_at: paid ? (data.paid_at ?? todayIso()) : (data.paid_at ?? null),
      notes: data.notes ?? null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function updatePayment(id: string, data: UpdatePaymentBody): Promise<Payment | undefined> {
  const existing = await findPaymentById(id)
  if (!existing) return undefined

  const values: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (data.amount !== undefined) values.amount = data.amount
  if (data.currency !== undefined) values.currency = data.currency
  if (data.period_start !== undefined) values.period_start = data.period_start
  if (data.period_end !== undefined) values.period_end = data.period_end
  if (data.due_date !== undefined) values.due_date = data.due_date
  if (data.notes !== undefined) values.notes = data.notes
  if (data.paid !== undefined) {
    values.paid = data.paid ? 1 : 0
    // Toggling paid manages paid_at unless the caller set it explicitly: stamp
    // today's date when marking paid, clear it when marking unpaid.
    if (data.paid_at !== undefined) values.paid_at = data.paid_at
    else values.paid_at = data.paid ? (existing.paid_at ?? todayIso()) : null
  } else if (data.paid_at !== undefined) {
    values.paid_at = data.paid_at
  }

  return getDb()
    .updateTable('payments')
    .set(values)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
}

export async function deletePayment(id: string): Promise<Payment | undefined> {
  return getDb().deleteFrom('payments').where('id', '=', id).returningAll().executeTakeFirst()
}

/**
 * Create the next billing period from an existing payment by shifting its dates
 * forward one month (the common recurring case). The new period starts unpaid.
 */
export async function renewPayment(id: string): Promise<Payment | undefined> {
  const prev = await findPaymentById(id)
  if (!prev) return undefined
  return createPayment({
    athlete_id: prev.athlete_id,
    amount: prev.amount,
    currency: prev.currency,
    period_start: prev.period_start ? addMonths(prev.period_start, 1) : null,
    period_end: prev.period_end ? addMonths(prev.period_end, 1) : null,
    due_date: addMonths(prev.due_date, 1),
    paid: false,
  })
}

/**
 * One reminder per athlete for the dashboard: take each athlete's current
 * (latest by due date) payment and include it only when its derived status needs
 * attention (overdue / due soon / expiring soon). Sorted most-urgent first.
 */
export async function getPaymentAlerts(today = todayIso()): Promise<PaymentAlert[]> {
  const rows = await getDb()
    .selectFrom('payments')
    .innerJoin('athletes', 'athletes.id', 'payments.athlete_id')
    .select([
      'payments.id as id',
      'payments.athlete_id as athlete_id',
      'payments.amount as amount',
      'payments.currency as currency',
      'payments.period_start as period_start',
      'payments.period_end as period_end',
      'payments.due_date as due_date',
      'payments.paid as paid',
      'payments.paid_at as paid_at',
      'payments.notes as notes',
      'payments.created_at as created_at',
      'payments.updated_at as updated_at',
      'athletes.name as athleteName',
    ])
    .execute()

  // Keep only the latest period per athlete.
  const latest = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const current = latest.get(row.athlete_id)
    if (!current || row.due_date > current.due_date) latest.set(row.athlete_id, row)
  }

  const order: Record<string, number> = { overdue: 0, due_soon: 1, expiring_soon: 2 }
  const alerts: PaymentAlert[] = []
  for (const row of latest.values()) {
    const { athleteName, ...payment } = row
    const status = paymentStatus(payment as Payment, today)
    if (paymentNeedsAttention(status)) {
      alerts.push({ athleteId: payment.athlete_id, athleteName, payment: payment as Payment, status })
    }
  }
  return alerts.sort(
    (a, b) =>
      (order[a.status] - order[b.status]) || a.payment.due_date.localeCompare(b.payment.due_date),
  )
}
