import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../components/ui/select'
import { useToast } from '../components/ui/toast'
import PageHeader, { BackLink } from '../components/PageHeader'
import { WEIGHT_CLASSES, isPowerlifting } from 'coachboard-shared'
import { LOAD_UNITS, type LoadUnit } from 'coachboard-shared/units'
import { getJson } from '../lib/api'

export default function NewAthlete() {
  const navigate = useNavigate()
  const toast = useToast()
  const [form, setForm] = useState({ name: '', email: '', sport: '', weight_class: '', date_of_birth: '', notes: '' })
  const [saving, setSaving] = useState(false)
  // kg or lb (S3, D78): starts on the Settings default.
  const [unit, setUnit] = useState<LoadUnit>('kg')
  useEffect(() => {
    getJson<{ defaultUnit: LoadUnit }>('/api/settings/units').then((r) => setUnit(r.defaultUnit)).catch(() => { /* kg */ })
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/athletes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, unit }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        toast.error(`Failed to create athlete: ${err.error ?? JSON.stringify(err)}`)
        setSaving(false)
        return
      }
      const athlete = await res.json()
      navigate(`/athletes/${athlete.id}`)
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <BackLink to="/athletes">Athletes</BackLink>
      <PageHeader title="New Athlete" />
      <Card>
        <CardHeader><CardTitle>Athlete Details</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sport">Sport</Label>
              <Input id="sport" value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} />
            </div>
            {isPowerlifting(form.sport) && (
              <div className="space-y-1">
                <Label htmlFor="weight_class">Weight class</Label>
                <Select value={form.weight_class} onValueChange={(v) => setForm({ ...form, weight_class: v })}>
                  <SelectTrigger id="weight_class"><SelectValue placeholder="Select weight class…" /></SelectTrigger>
                  <SelectContent>
                    {WEIGHT_CLASSES.men.map((w) => <SelectItem key={`m${w}`} value={w}>{w} kg (men)</SelectItem>)}
                    {WEIGHT_CLASSES.women.map((w) => <SelectItem key={`w${w}`} value={w}>{w} kg (women)</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Unit</Label>
              <div role="radiogroup" aria-label="Unit" className="flex gap-2">
                {LOAD_UNITS.map((u) => (
                  <label key={u} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${unit === u ? 'border-primary bg-primary/10' : ''}`}>
                    <input type="radio" name="unit" className="accent-primary" checked={unit === u} onChange={() => setUnit(u)} />
                    {u}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Their loads, maxes and sheets are in this unit.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="date_of_birth">Date of Birth</Label>
              <Input id="date_of_birth" type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Create Athlete'}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
