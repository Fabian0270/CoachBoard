// Payment status derivation — the single source of truth shared by the client
// (overview page, per-athlete section) and the server (dashboard alerts), so
// both agree on what "overdue" / "due soon" / "expiring" mean.

import type { Payment, PaymentStatus } from './types.js'

// How many days ahead counts as a reminder ("due soon" / "expiring soon").
export const PAYMENT_REMINDER_DAYS = 7

// Whole days from `fromIso` to `toIso` (both YYYY-MM-DD). Negative = in the past.
function daysUntil(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number)
  const [ty, tm, td] = toIso.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/**
 * Derive a payment's status relative to `todayIso` (YYYY-MM-DD).
 * Unpaid periods report overdue / due_soon / upcoming off the due date; paid
 * periods report expiring_soon when their coverage window is ending (so the
 * coach knows to collect the next one), otherwise paid.
 */
export function paymentStatus(payment: Payment, todayIso: string): PaymentStatus {
  if (payment.paid) {
    if (payment.period_end && daysUntil(todayIso, payment.period_end) <= PAYMENT_REMINDER_DAYS) {
      return 'expiring_soon'
    }
    return 'paid'
  }
  const due = daysUntil(todayIso, payment.due_date)
  if (due < 0) return 'overdue'
  if (due <= PAYMENT_REMINDER_DAYS) return 'due_soon'
  return 'upcoming'
}

// Statuses that warrant a dashboard reminder.
export function paymentNeedsAttention(status: PaymentStatus): boolean {
  return status === 'overdue' || status === 'due_soon' || status === 'expiring_soon'
}
