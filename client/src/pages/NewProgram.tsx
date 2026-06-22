import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { ArrowLeft } from 'lucide-react'

interface Athlete { id: string; name: string }
interface ExportStyle { id: string; name: string }

// Sentinel for the "no saved style" Select option (Radix Select disallows "").
const NO_STYLE = '__none__'

export default function NewProgram() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [styles, setStyles] = useState<ExportStyle[]>([])
  const [styleSourceId, setStyleSourceId] = useState<string>(NO_STYLE)
  const [form, setForm] = useState({
    athlete_id: searchParams.get('athlete_id') ?? '',
    name: '',
    description: '',
    start_date: '',
    end_date: '',
    status: 'active',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/athletes')
      .then((r) => r.json())
      .then((data) => setAthletes(Array.isArray(data) ? data : []))
      .catch(() => {})
    fetch('/api/export-styles')
      .then((r) => r.json())
      .then((data) => setStyles(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          export_style_id: styleSourceId === NO_STYLE ? undefined : styleSourceId,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        alert(`Failed to create program: ${err.error ?? JSON.stringify(err)}`)
        setSaving(false)
        return
      }
      const program = await res.json()
      navigate(`/programs/${program.id}`)
    } catch (err) {
      alert(`Network error: ${String(err)}`)
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/programs"><ArrowLeft className="h-5 w-5 text-muted-foreground" /></Link>
        <h1 className="text-3xl font-bold">New Program</h1>
      </div>
      <Card>
        <CardHeader><CardTitle>Program Details</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label>Athlete *</Label>
              <Select value={form.athlete_id} onValueChange={(v) => setForm({ ...form, athlete_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select athlete" /></SelectTrigger>
                <SelectContent>
                  {athletes.map((athlete) => <SelectItem key={athlete.id} value={athlete.id}>{athlete.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="name">Program Name *</Label>
              <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            {styles.length > 0 && (
              <div className="space-y-1">
                <Label>Excel style</Label>
                <Select value={styleSourceId} onValueChange={setStyleSourceId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_STYLE}>CoachBoard default</SelectItem>
                    {styles.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Export this program in a saved coach layout instead of the default style.
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="start">Start Date</Label>
                <Input id="start" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="end">End Date</Label>
                <Input id="end" type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
              </div>
            </div>
            <Button type="submit" disabled={saving || !form.athlete_id}>{saving ? 'Saving...' : 'Create Program'}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
