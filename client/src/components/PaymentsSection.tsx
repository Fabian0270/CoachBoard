import { useEffect, useState } from 'react'
import type { Payment, UpdatePaymentBody } from 'coachboard-shared'
import { paymentStatus } from 'coachboard-shared/payments'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { Badge } from './ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Plus, Trash2, RefreshCw, Check, Undo2 } from 'lucide-react'
import { PAYMENT_STATUS_META, CURRENCY_OPTIONS, formatAmount, todayIso } from '../lib/paymentDisplay'

const emptyForm = () => ({
  amount: '',
  currency: 'SEK',
  due_date: todayIso(),
  period_start: '',
  period_end: '',
  paid: false,
  notes: '',
})

export default function PaymentsSection({ athleteId }: { athleteId: string }) {
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const today = todayIso()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/payments?athlete_id=${athleteId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (!cancelled) { setPayments(Array.isArray(data) ? data : []); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [athleteId])

  // Keep the list ordered by due date, newest first (matches the API).
  const sortInto = (list: Payment[]) =>
    [...list].sort((a, b) => b.due_date.localeCompare(a.due_date))

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          amount: Number(form.amount),
          currency: form.currency,
          due_date: form.due_date,
          period_start: form.period_start || null,
          period_end: form.period_end || null,
          paid: form.paid,
          notes: form.notes || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        alert(`Failed to add payment: ${err.error ?? JSON.stringify(err)}`)
        return
      }
      const created: Payment = await res.json()
      setPayments((list) => sortInto([...list, created]))
      setForm(emptyForm())
    } catch (err) {
      alert(`Network error: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const patch = async (id: string, body: UpdatePaymentBody) => {
    const res = await fetch(`/api/payments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const updated: Payment = await res.json()
      setPayments((list) => sortInto(list.map((p) => (p.id === id ? updated : p))))
    }
  }

  const handleRenew = async (id: string) => {
    const res = await fetch(`/api/payments/${id}/renew`, { method: 'POST' })
    if (res.ok) {
      const next: Payment = await res.json()
      setPayments((list) => sortInto([...list, next]))
    }
  }

  const handleDelete = async (p: Payment) => {
    if (!confirm(`Delete the ${formatAmount(p.amount, p.currency)} payment due ${p.due_date}?`)) return
    const res = await fetch(`/api/payments/${p.id}`, { method: 'DELETE' })
    if (res.ok || res.status === 404) {
      setPayments((list) => list.filter((x) => x.id !== p.id))
    }
  }

  if (loading) return <div className="text-muted-foreground">Loading…</div>

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Record a payment</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <Label htmlFor="pay-amount">Amount</Label>
              <Input
                id="pay-amount" required type="number" min="0" step="any" className="w-28"
                value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Currency</Label>
              <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v })}>
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pay-due">Due date</Label>
              <Input
                id="pay-due" type="date" value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pay-start">Period start</Label>
              <Input
                id="pay-start" type="date" value={form.period_start}
                onChange={(e) => setForm({ ...form, period_start: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pay-end">Period end</Label>
              <Input
                id="pay-end" type="date" value={form.period_end}
                onChange={(e) => setForm({ ...form, period_end: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm h-9">
              <input
                type="checkbox" checked={form.paid}
                onChange={(e) => setForm({ ...form, paid: e.target.checked })}
              />
              Already paid
            </label>
            <div className="space-y-1 flex-1 min-w-[10rem]">
              <Label htmlFor="pay-notes">Notes</Label>
              <Textarea
                id="pay-notes" rows={1} placeholder="e.g. Swish, invoice #…"
                value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
            <Button type="submit" disabled={saving}>
              <Plus className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Add'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {payments.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No payments recorded yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle>Payment history</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {payments.map((p) => {
              const status = paymentStatus(p, today)
              const meta = PAYMENT_STATUS_META[status]
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent/30">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-primary">{formatAmount(p.amount, p.currency)}</span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Due {p.due_date}
                      {p.period_start && p.period_end && <> · covers {p.period_start} → {p.period_end}</>}
                      {p.paid === 1 && p.paid_at && <> · paid {p.paid_at}</>}
                      {p.notes && <> · {p.notes}</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {p.paid === 1 ? (
                      <Button variant="ghost" size="sm" onClick={() => patch(p.id, { paid: false })} title="Mark unpaid">
                        <Undo2 className="h-4 w-4 mr-1" />Unpay
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => patch(p.id, { paid: true })} title="Mark paid">
                        <Check className="h-4 w-4 mr-1" />Mark paid
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleRenew(p.id)} title="Create next month">
                      <RefreshCw className="h-4 w-4 mr-1" />Renew
                    </Button>
                    <button
                      type="button" onClick={() => handleDelete(p)} aria-label="Delete payment"
                      className="p-1.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
