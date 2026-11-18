import { useCallback, useEffect, useState } from 'react'
import { Download, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { useToast } from './ui/toast'
import LoadError from './LoadError'
import { errorMessage, getJson, sendJson } from '../lib/api'
import { formatAmount } from '../lib/paymentDisplay'

// ---------------------------------------------------------------------------
// Revenue on the Payments page (S5, D84–D86): month by month, each currency on
// its own and a total in the coach's own currency, counted in the month paid
// or spread over the months covered. Plus the CSV of every payment.
// ---------------------------------------------------------------------------

type Basis = 'paid' | 'covered'
interface Row { month: string; byCurrency: Record<string, number>; totalHome: number | null }
interface Summary {
  home: string
  basis: Basis
  months: Row[]
  later: Row
  outstanding: Row
  rates: Record<string, number>
  sources: Record<string, 'ecb' | 'manual'>
  ecbDate: string | null
  missingRates: string[]
}

const COMMON = ['SEK', 'NOK', 'DKK', 'EUR', 'USD', 'GBP', 'CHF', 'PLN']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
const BASIS_KEY = 'coachboard-revenue-basis'

function readBasis(): Basis {
  try { return localStorage.getItem(BASIS_KEY) === 'covered' ? 'covered' : 'paid' } catch { return 'paid' }
}

export default function RevenueCard() {
  const toast = useToast()
  const [basis, setBasis] = useState<Basis>(readBasis)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      setSummary(await getJson<Summary>(`/api/payments/summary?basis=${basis}`))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [basis])
  useEffect(() => { void load() }, [load])

  const chooseBasis = (b: Basis) => {
    setBasis(b)
    try { localStorage.setItem(BASIS_KEY, b) } catch { /* fine */ }
  }

  const chooseHome = async (home: string) => {
    try {
      setSummary(await sendJson<Summary>('PUT', `/api/payments/currency?basis=${basis}`, { home }))
    } catch (e) {
      toast.error(`Could not change your currency. ${errorMessage(e)}`)
    }
  }

  const saveRates = async () => {
    if (!summary) return
    const typed: Record<string, number> = {}
    for (const [c, r] of Object.entries(summary.sources)) if (r === 'manual') typed[c] = summary.rates[c]
    for (const [c, text] of Object.entries(rateDraft)) {
      const n = Number(text.replace(',', '.'))
      if (n > 0) typed[c] = n
    }
    try {
      setSummary(await sendJson<Summary>('PUT', `/api/payments/rates?basis=${basis}`, { rates: typed }))
      setRateDraft({})
      toast.success('Rates saved')
    } catch (e) {
      toast.error(`Could not save the rates. ${errorMessage(e)}`)
    }
  }

  const downloadCsv = async () => {
    try {
      const res = await fetch('/api/payments/export.csv')
      if (!res.ok) throw new Error(`the server said ${res.status}`)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = 'coachboard-payments.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(`Could not export the payments. ${errorMessage(e)}`)
    }
  }

  if (error) return <LoadError what="your revenue" message={error} onRetry={() => void load()} />
  if (!summary) return null

  const rows = [...summary.months].reverse()
  const currencies = [...new Set([...rows, summary.later, summary.outstanding].flatMap((r) => Object.keys(r.byCurrency)))].sort()
  const others = currencies.filter((c) => c !== summary.home)
  const homeOptions = [...new Set([summary.home, ...COMMON, ...currencies])]
  const typedRates = Object.entries(summary.sources).filter(([, s]) => s === 'manual').map(([c]) => c)
  const needRate = [...new Set([...summary.missingRates, ...typedRates])].filter((c) => c !== summary.home).sort()
  const total = (r: Row) => (r.totalHome == null || Object.keys(r.byCurrency).length === 0 ? '—' : formatAmount(r.totalHome, summary.home))
  const line = (label: string, r: Row, muted = false) => (
    <tr key={label} className={`border-b last:border-0 ${muted ? 'text-muted-foreground' : ''}`}>
      <td className="py-1.5 pr-4">{label}</td>
      {currencies.map((c) => (
        <td key={c} className="num py-1.5 pr-4 text-right">{r.byCurrency[c] ? formatAmount(r.byCurrency[c], c) : '—'}</td>
      ))}
      {others.length > 0 && <td className="num py-1.5 text-right font-medium">{total(r)}</td>}
    </tr>
  )

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="h-5 w-5 text-muted-foreground" />Revenue</CardTitle>
          <Button variant="outline" size="sm" onClick={() => void downloadCsv()}><Download className="h-4 w-4" /> Export CSV</Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Your currency</span>
            <select
              aria-label="Your currency"
              value={summary.home}
              onChange={(e) => void chooseHome(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              {homeOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div role="radiogroup" aria-label="Count payments" className="inline-flex rounded-md border p-0.5 text-xs">
            {([['paid', 'Month paid'], ['covered', 'Spread over months covered']] as const).map(([b, label]) => (
              <button
                key={b} type="button" role="radio" aria-checked={basis === b} onClick={() => chooseBasis(b)}
                className={`rounded px-2 py-0.5 font-medium ${basis === b ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {basis === 'paid'
            ? 'Each payment counts in full in the month it was marked paid — what came into your account.'
            : 'Each payment is spread evenly over the days it covers — what you earned each month. Money already in for later months shows as paid ahead.'}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Revenue per month">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Month</th>
                {currencies.map((c) => <th key={c} className="pb-2 pr-4 text-right font-medium">{c}</th>)}
                {others.length > 0 && <th className="pb-2 text-right font-medium">Total in {summary.home}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => line(monthLabel(r.month), r))}
              {basis === 'covered' && Object.keys(summary.later.byCurrency).length > 0 && line('Paid ahead', summary.later, true)}
              {Object.keys(summary.outstanding.byCurrency).length > 0 && line('Not paid yet', summary.outstanding, true)}
            </tbody>
          </table>
        </div>
        {currencies.length === 0 && <p className="text-sm text-muted-foreground">No payments yet.</p>}
        {others.length > 0 && (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              {summary.ecbDate
                ? `Totals use the European Central Bank’s rates of ${summary.ecbDate}`
                : 'The European Central Bank’s rates could not be fetched'}
              {typedRates.length > 0 ? `, and your own for ${typedRates.join(', ')}.` : '.'}
              {summary.missingRates.length > 0 && ` No rate yet for ${summary.missingRates.join(', ')} — type one below to see the total.`}
            </p>
            {needRate.length > 0 && (
              <div className="flex flex-wrap items-end gap-3">
                {needRate.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-sm text-foreground">
                    1 {c} =
                    <input
                      aria-label={`${summary.home} per ${c}`}
                      inputMode="decimal"
                      value={rateDraft[c] ?? (summary.sources[c] === 'manual' ? String(summary.rates[c]) : '')}
                      onChange={(e) => setRateDraft((d) => ({ ...d, [c]: e.target.value }))}
                      className="num h-8 w-24 rounded-md border bg-background px-2 text-sm"
                    />
                    {summary.home}
                  </label>
                ))}
                <Button size="sm" variant="outline" onClick={() => void saveRates()}>Save rates</Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
