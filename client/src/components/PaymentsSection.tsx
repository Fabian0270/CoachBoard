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
import { useToast } from './ui/toast'
import { useConfirm } from './ui/confirm-dialog'
import { Plus, Trash2, RefreshCw, Check, Undo2 } from 'lucide-react'
import { PAYMENT_STATUS_META, CURRENCY_OPTIONS, formatAmount, todayIso, addDays } from '../lib/paymentDisplay'

const emptyForm = () => ({
  amount: '',
  currency: 'SEK',
  // 'date' = pick the paid-through date directly; 'weeks' = pay N weeks forward
  // from a start date and let us compute the paid-through date.
  dateMode: 'date' as 'date' | 'weeks',
  paid_through: todayIso(),
  startDate: todayIso(),
  weeks: '',
  paid: false,
  notes: '',
})

export default function PaymentsSection({ athleteId }: { athleteId: string }) {
  const toast = useToast()
  const confirm = useConfirm()
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

  // Keep the list ordered by coverage date, newest first (matches the API).
  const sortInto = (list: Payment[]) =>
    [...list].sort((a, b) => b.paid_through.localeCompare(a.paid_through))

  // Resolve the paid-through date from whichever mode the coach used.
  // Weeks mode counts forward from the chosen start date.
  const resolvedPaidThrough =
    form.dateMode === 'weeks'
      ? (form.weeks && form.startDate ? addDays(form.startDate, Number(form.weeks) * 7) : '')
      : form.paid_through

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resolvedPaidThrough) {
      toast.info('Set a paid-through date, or enter how many weeks are paid forward.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          amount: Number(form.amount),
          currency: form.currency,
          start_date: form.startDate || null,
          paid_through: resolvedPaidThrough,
          paid: form.paid,
          notes: form.notes || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        toast.error(`Failed to add payment: ${err.error ?? JSON.stringify(err)}`)
        return
      }
      const created: Payment = await res.json()
      setPayments((list) => sortInto([...list, created]))
      setForm(emptyForm())
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
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
    if (!(await confirm({
      title: `Delete the ${formatAmount(p.amount, p.currency)} payment (through ${p.paid_through})?`,
      confirmLabel: 'Delete',
      destructive: true,
    }))) return
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
              <Label>Coverage</Label>
              <div className="flex flex-wrap gap-2 items-end">
                <div className="space-y-1">
                  <span className="block text-xs text-muted-foreground">Start date</span>
                  <Input
                    id="pay-start" type="date" className="w-40" value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <span className="block text-xs text-muted-foreground">
                    {form.dateMode === 'date' ? 'End date' : 'Weeks'}
                  </span>
                  <div className="flex items-end gap-1.5">
                    {form.dateMode === 'date' ? (
                      <Input
                        id="pay-through" type="date" className="w-40" value={form.paid_through}
                        onChange={(e) => setForm({ ...form, paid_through: e.target.value })}
                      />
                    ) : (
                      <Input
                        id="pay-weeks" type="number" min="1" step="1" className="w-28" placeholder="weeks"
                        value={form.weeks}
                        onChange={(e) => setForm({ ...form, weeks: e.target.value })}
                      />
                    )}
                    <div className="flex gap-1">
                      <Button
                        type="button" size="sm"
                        variant={form.dateMode === 'date' ? 'default' : 'outline'}
                        onClick={() => setForm({ ...form, dateMode: 'date' })}
                      >
                        Date
                      </Button>
                      <Button
                        type="button" size="sm"
                        variant={form.dateMode === 'weeks' ? 'default' : 'outline'}
                        onClick={() => setForm({ ...form, dateMode: 'weeks' })}
                      >
                        Weeks
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
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
                      {p.start_date
                        ? <>Covers {p.start_date} → {p.paid_through}</>
                        : <>{p.paid === 1 ? 'Paid through' : 'Due by'} {p.paid_through}</>}
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
