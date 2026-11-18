// ---------------------------------------------------------------------------
// Revenue per month (S5, D84–D86).
//
// Two ways to count a paid payment (D86), the coach switches between them:
// - 'paid' (the default): the whole amount in the month it was marked paid,
//   like the bank account and small-business cash bookkeeping;
// - 'covered': spread evenly by day over start_date..paid_through, the months
//   the coaching was for. One without a start date counts in the month of its
//   paid_through.
// Each currency is kept on its own; a total in the coach's own currency is
// added when every currency in it has a rate (D84).
// ---------------------------------------------------------------------------

export type RevenueBasis = 'paid' | 'covered'

export interface RevenuePayment {
  amount: number
  currency: string
  start_date: string | null
  paid_through: string
  paid: number | boolean
  paid_at?: string | null
}

/** "SEK", "eur " → "EUR". */
export const currencyCode = (c: string) => c.trim().toUpperCase()

const dayMs = 86_400_000
const toUtc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7)

/** month (YYYY-MM) → currency → amount, for paid payments, counted by `basis`. */
export function revenueByMonth(payments: RevenuePayment[], basis: RevenueBasis = 'paid'): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  const add = (month: string, currency: string, amount: number) => {
    const m = out.get(month) ?? new Map<string, number>()
    m.set(currency, (m.get(currency) ?? 0) + amount)
    out.set(month, m)
  }
  for (const p of payments) {
    if (!p.paid || !(p.amount > 0) || !p.paid_through) continue
    const currency = currencyCode(p.currency)
    if (basis === 'paid') {
      // Marked paid without a date (older rows): the end of its period is the best guess.
      add((p.paid_at || p.paid_through).slice(0, 7), currency, p.amount)
      continue
    }
    const end = toUtc(p.paid_through)
    const start = p.start_date ? toUtc(p.start_date) : null
    if (start == null || start > end) {
      add(monthOf(end), currency, p.amount)
      continue
    }
    const days = Math.round((end - start) / dayMs) + 1
    const perDay = p.amount / days
    // Day by day is plenty fast for coaching periods (weeks to a year).
    let monthStart = start
    let count = 0
    for (let t = start; t <= end; t += dayMs) {
      if (monthOf(t) !== monthOf(monthStart)) {
        add(monthOf(monthStart), currency, perDay * count)
        monthStart = t
        count = 0
      }
      count++
    }
    add(monthOf(monthStart), currency, perDay * count)
  }
  return out
}

/** Unpaid payments, per currency: what is still to come in. */
export function outstanding(payments: RevenuePayment[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of payments) {
    if (p.paid || !(p.amount > 0)) continue
    const c = currencyCode(p.currency)
    out.set(c, (out.get(c) ?? 0) + p.amount)
  }
  return out
}

/**
 * How many units of the home currency one unit of each currency is worth.
 * `home` itself is always 1. A currency missing here has no rate.
 */
export type HomeRates = Record<string, number>

/** A total in the home currency, or null when a currency in it has no rate. */
export function totalInHome(byCurrency: Map<string, number>, rates: HomeRates): number | null {
  let total = 0
  for (const [c, amount] of byCurrency) {
    const r = rates[c]
    if (!(r > 0)) return null
    total += amount * r
  }
  return total
}

/**
 * Home rates from reference rates quoted against one base (the ECB's are per
 * EUR: 1 EUR = 11.46 SEK). 1 X in home = (units of home per base) / (units of X per base).
 */
export function homeRatesFromBase(perBase: Record<string, number>, base: string, home: string): HomeRates {
  const all: Record<string, number> = { ...perBase, [base]: 1 }
  const homePerBase = all[home]
  if (!(homePerBase > 0)) return { [home]: 1 }
  const out: HomeRates = {}
  for (const [c, perBaseRate] of Object.entries(all)) {
    if (perBaseRate > 0) out[c] = homePerBase / perBaseRate
  }
  out[home] = 1
  return out
}

/** The last `count` months up to and including `current` (YYYY-MM), oldest first. */
export function lastMonths(current: string, count: number): string[] {
  const [y, m] = current.split('-').map(Number)
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1))
    return d.toISOString().slice(0, 7)
  })
}
