import type { PaymentStatus } from 'coachboard-shared'

// Badge label + variant per derived payment status, shared by the payments page,
// the per-athlete section and the dashboard reminders.
export const PAYMENT_STATUS_META: Record<
  PaymentStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  overdue: { label: 'Overdue', variant: 'destructive' },
  due_soon: { label: 'Due soon', variant: 'default' },
  expiring_soon: { label: 'Expiring soon', variant: 'default' },
  upcoming: { label: 'Upcoming', variant: 'outline' },
  paid: { label: 'Paid', variant: 'secondary' },
}

// Common currency codes offered in the picker (currency is per-record).
export const CURRENCY_OPTIONS = ['SEK', 'USD', 'EUR', 'GBP', 'NOK', 'DKK'] as const

export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    // Unknown/custom currency code — fall back to a plain "amount CODE".
    return `${amount} ${currency}`
  }
}

export const todayIso = (): string => new Date().toISOString().slice(0, 10)
