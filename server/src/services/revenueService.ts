import { getDb } from '../db.js'
import { lastMonths, outstanding, revenueByMonth, totalInHome, type RevenueBasis } from 'coachboard-shared/revenue'
import { ratesIntoHome } from './ratesService.js'
import { todayIso } from './paymentService.js'

// ---------------------------------------------------------------------------
// The Payments page's revenue summary and CSV export (S5, D84–D86).
// ---------------------------------------------------------------------------

export interface RevenueRow {
  /** YYYY-MM; 'later' for months after this one (paid ahead, when spread); 'outstanding' for unpaid. */
  month: string
  byCurrency: Record<string, number>
  /** Null when a currency in this row has no rate. */
  totalHome: number | null
}

export interface RevenueSummary {
  home: string
  /** How payments were counted (D86). */
  basis: RevenueBasis
  months: RevenueRow[]
  later: RevenueRow
  outstanding: RevenueRow
  rates: Record<string, number>
  sources: Record<string, 'ecb' | 'manual'>
  ecbDate: string | null
  /** Currencies in the payments with no rate into the home currency. */
  missingRates: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100
const asRecord = (m: Map<string, number>) => Object.fromEntries([...m].map(([c, v]) => [c, round2(v)]))

export async function revenueSummary(opts: { months?: number; today?: string; now?: Date; basis?: RevenueBasis } = {}): Promise<RevenueSummary> {
  const basis = opts.basis ?? 'paid'
  const today = opts.today ?? todayIso()
  const payments = await getDb().selectFrom('payments').selectAll().execute()
  const info = await ratesIntoHome(opts.now)
  const byMonth = revenueByMonth(payments, basis)
  const current = today.slice(0, 7)
  const row = (month: string, m: Map<string, number>): RevenueRow => ({ month, byCurrency: asRecord(m), totalHome: totalInHome(m, info.rates) === null ? null : round2(totalInHome(m, info.rates)!) })

  const later = new Map<string, number>()
  for (const [month, m] of byMonth) {
    if (month <= current) continue
    for (const [c, v] of m) later.set(c, (later.get(c) ?? 0) + v)
  }
  const out = outstanding(payments)
  const seen = new Set(payments.map((p) => p.currency.trim().toUpperCase()))
  return {
    home: info.home,
    basis,
    months: lastMonths(current, opts.months ?? 12).map((m) => row(m, byMonth.get(m) ?? new Map())),
    later: row('later', later),
    outstanding: row('outstanding', out),
    rates: info.rates,
    sources: info.sources,
    ecbDate: info.ecbDate,
    missingRates: [...seen].filter((c) => !(info.rates[c] > 0)).sort(),
  }
}

/** One cell of CSV: quoted when it holds a comma, quote or line break. */
const cell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Every payment, newest period first, as CSV with a BOM so Excel reads å, ä and ö. */
export async function paymentsCsv(): Promise<string> {
  const rows = await getDb().selectFrom('payments')
    .innerJoin('athletes', 'athletes.id', 'payments.athlete_id')
    .select(['athletes.name as athlete', 'payments.amount', 'payments.currency', 'payments.start_date', 'payments.paid_through', 'payments.paid', 'payments.paid_at', 'payments.notes'])
    .orderBy('payments.paid_through', 'desc')
    .execute()
  const header = ['Athlete', 'Amount', 'Currency', 'From', 'Paid through', 'Paid', 'Paid on', 'Notes']
  const lines = [header, ...rows.map((r) => [r.athlete, r.amount, r.currency, r.start_date, r.paid_through, r.paid ? 'yes' : 'no', r.paid_at, r.notes])]
  return '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'
}
