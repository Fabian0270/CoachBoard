import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaymentAlert } from 'coachboard-shared'
import { getList, errorMessage } from '../lib/api'
import LoadError from '../components/LoadError'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { AlertTriangle, Wallet } from 'lucide-react'
import PaymentsSection from '../components/PaymentsSection'
import { PAYMENT_STATUS_META, formatAmount } from '../lib/paymentDisplay'

interface Athlete { id: string; name: string }

export default function Payments() {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [alerts, setAlerts] = useState<PaymentAlert[]>([])
  const [selectedAthlete, setSelectedAthlete] = useState<string>('')
  // "All payments are up to date" is the empty state here, so a swallowed
  // failure told the coach every invoice was settled. Of the misleading empty
  // states this one costs money.
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [list, alertRows] = await Promise.all([
        getList<Athlete>('/api/athletes'),
        getList<PaymentAlert>('/api/payments/alerts'),
      ])
      setAthletes(list)
      setAlerts(alertRows)
      if (list.length) setSelectedAthlete((current) => current || list[0].id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold flex items-center gap-2"><Wallet className="h-7 w-7" />Payments</h1>
        <LoadError what="your payments" message={error} onRetry={() => void load()} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold flex items-center gap-2"><Wallet className="h-7 w-7" />Payments</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />Needs attention
          </CardTitle>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <p className="text-muted-foreground">All payments are up to date.</p>
          ) : (
            <div className="space-y-1">
              {alerts.map((a) => {
                const meta = PAYMENT_STATUS_META[a.status]
                return (
                  <div key={a.payment.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent/30">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link to={`/athletes/${a.athleteId}`} className="font-medium hover:underline">{a.athleteName}</Link>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      <span className="text-sm text-muted-foreground">
                        {formatAmount(a.payment.amount, a.payment.currency)} ·{' '}
                        {a.status === 'expiring_soon' ? 'paid through' : 'due by'} {a.payment.paid_through}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {athletes.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No athletes found. Add athletes first.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          <Select value={selectedAthlete} onValueChange={setSelectedAthlete}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Select athlete" /></SelectTrigger>
            <SelectContent>
              {athletes.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {selectedAthlete && <PaymentsSection athleteId={selectedAthlete} />}
        </div>
      )}
    </div>
  )
}
