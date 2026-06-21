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
 * Derive a payment's status relative to `todayIso` (YYYY-MM-DD), driven by the
 * single `paid_through` date. Paid periods report expiring_soon as coverage runs
 * out (so the coach knows to collect the next one); unpaid periods report
 * overdue / due_soon / upcoming.
 */
export function paymentStatus(payment: Payment, todayIso: string): PaymentStatus {
  // Defensive: a row migrated from the old multi-date model may have no
  // paid_through. Don't crash — treat it as settled / not-yet-due.
  if (!payment.paid_through) return payment.paid ? 'paid' : 'upcoming'
  const days = daysUntil(todayIso, payment.paid_through)
  if (payment.paid) {
    return days <= PAYMENT_REMINDER_DAYS ? 'expiring_soon' : 'paid'
  }
  if (days < 0) return 'overdue'
  if (days <= PAYMENT_REMINDER_DAYS) return 'due_soon'
  return 'upcoming'
}

// Statuses that warrant a dashboard reminder.
export function paymentNeedsAttention(status: PaymentStatus): boolean {
  return status === 'overdue' || status === 'due_soon' || status === 'expiring_soon'
}
