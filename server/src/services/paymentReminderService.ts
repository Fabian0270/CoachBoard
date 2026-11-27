import { getDb } from '../db.js'
import { paymentStatus } from 'coachboard-shared/payments'
import type { Payment } from 'coachboard-shared'
import { getSettings } from './emailSettingsService.js'
import { sendTextEmail, type SendResult } from './emailService.js'
import { todayIso } from './paymentService.js'

// ---------------------------------------------------------------------------
// Payment reminders (S5, D87): a draft the coach reads and edits, sent only
// when they click Send, to the athlete's email over the coach's own setup.
// Only for payments that are due soon or overdue.
// ---------------------------------------------------------------------------

export interface ReminderDraft {
  paymentId: string
  athleteName: string
  /** The athlete's email; null when none is on file (the dialog says so). */
  to: string | null
  subject: string
  body: string
  status: 'due_soon' | 'overdue'
  remindedAt: string | null
  emailConfigured: boolean
}

export class ReminderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** "1 200 kr", "€120.00": the amount as the athlete expects to read it. */
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

async function load(paymentId: string) {
  const row = await getDb().selectFrom('payments')
    .innerJoin('athletes', 'athletes.id', 'payments.athlete_id')
    .selectAll('payments')
    .select(['athletes.name as athleteName', 'athletes.email as athleteEmail'])
    .where('payments.id', '=', paymentId)
    .executeTakeFirst()
  if (!row) throw new ReminderError('Payment not found', 404)
  const status = paymentStatus(row as unknown as Payment, todayIso())
  if (status !== 'due_soon' && status !== 'overdue') {
    throw new ReminderError('Reminders are for payments that are due soon or overdue', 409)
  }
  return { row, status }
}

export async function reminderDraft(paymentId: string): Promise<ReminderDraft> {
  const { row, status } = await load(paymentId)
  const settings = await getSettings()
  const first = row.athleteName.trim().split(/\s+/)[0] || row.athleteName
  const amount = money(row.amount, row.currency.trim().toUpperCase())
  const when = longDate(row.paid_through)
  const sign = settings?.fromName?.trim()
  return {
    paymentId,
    athleteName: row.athleteName,
    to: row.athleteEmail?.trim() || null,
    subject: status === 'overdue' ? `Payment reminder — ${amount} was due ${when}` : `Payment reminder — ${amount} due ${when}`,
    body: [
      `Hi ${first},`,
      '',
      status === 'overdue'
        ? `A friendly reminder that your coaching payment of ${amount} was due on ${when}. If you have already paid, thank you — just let me know and I'll update it.`
        : `A friendly reminder that your coaching payment of ${amount} is due on ${when}.`,
      '',
      'Thanks!',
      ...(sign ? [sign] : []),
    ].join('\n'),
    status,
    remindedAt: row.reminded_at ?? null,
    emailConfigured: !!settings,
  }
}

/** Sends the coach's (possibly edited) reminder, and records when. */
export async function sendReminder(paymentId: string, message: { subject: string; body: string }): Promise<SendResult> {
  const { row } = await load(paymentId)
  const to = row.athleteEmail?.trim()
  if (!to) throw new ReminderError(`${row.athleteName} has no email address. Add one on their page first.`, 400)
  const result = await sendTextEmail({ to, subject: message.subject, body: message.body })
  if (result.ok) {
    await getDb().updateTable('payments').set({ reminded_at: new Date().toISOString() }).where('id', '=', paymentId).execute()
  }
  return result
}
