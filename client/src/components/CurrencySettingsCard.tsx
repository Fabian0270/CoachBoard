import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { useToast } from './ui/toast'
import LoadError from './LoadError'
import { errorMessage, getJson, sendJson } from '../lib/api'

// The coach's own currency (S5, D84): what the Payments page totals revenue in.
// The same setting as the "Your currency" choice on the Revenue card.

/** Common first, then the rest the European Central Bank quotes. */
export const CURRENCIES = [
  'SEK', 'NOK', 'DKK', 'EUR', 'USD', 'GBP', 'CHF', 'PLN',
  'AUD', 'BGN', 'BRL', 'CAD', 'CNY', 'CZK', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY',
  'KRW', 'MXN', 'MYR', 'NZD', 'PHP', 'RON', 'SGD', 'THB', 'TRY', 'ZAR',
]

export default function CurrencySettingsCard() {
  const toast = useToast()
  const [home, setHome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    getJson<{ home: string }>('/api/settings/currency')
      .then((r) => { setHome(r.home); setError(null) })
      .catch((e) => setError(errorMessage(e)))
  }, [attempt])

  const choose = async (next: string) => {
    const before = home
    setHome(next)
    try {
      await sendJson('PUT', '/api/settings/currency', { home: next })
      toast.success(`Revenue is now totalled in ${next}.`)
    } catch (e) {
      setHome(before)
      toast.error(`Could not save your currency. ${errorMessage(e)}`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Currency</CardTitle>
        <CardDescription>
          Your own currency. The Payments page totals your revenue in it, converting other currencies with the
          European Central Bank’s daily rates. Each payment keeps the currency it was charged in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <LoadError what="your currency" message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : home === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Your currency</span>
            <select
              aria-label="Your currency"
              value={home}
              onChange={(e) => void choose(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              {[...new Set([home, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
      </CardContent>
    </Card>
  )
}
