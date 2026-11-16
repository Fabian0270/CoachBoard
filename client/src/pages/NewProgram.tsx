import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { useToast } from '../components/ui/toast'
import PageHeader, { BackLink } from '../components/PageHeader'
import TemplatePicker from '../components/TemplatePicker'
import { errorMessage, getJson, getList, sendJson } from '../lib/api'
import { blockDates, nextMonday } from '../lib/dates'
import type { CoachStyleProfile } from 'coachboard-shared'

interface Athlete { id: string; name: string }
interface ExportStyle { id: string; name: string }

// Sentinel for the "no saved style" Select option (Radix Select disallows "").
const NO_STYLE = '__none__'

export default function NewProgram() {
  const navigate = useNavigate()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [styles, setStyles] = useState<ExportStyle[]>([])
  const [styleSourceId, setStyleSourceId] = useState<string>(NO_STYLE)
  const [builtinTemplate, setBuiltinTemplate] = useState<string>('coachboard')
  // Start date and length in one step. They used to be two optional dates, and a
  // program created without them landed on a second "Set program duration" form
  // before the coach could write a single exercise.
  const [form, setForm] = useState({
    athlete_id: searchParams.get('athlete_id') ?? '',
    name: '',
    description: '',
    start_date: nextMonday(),
    weeks: '4',
    status: 'active',
  })
  // The coach's usual block length replaces the 4 — unless they have already
  // typed a length themselves.
  const [weeksTouched, setWeeksTouched] = useState(false)
  const [usualWeeks, setUsualWeeks] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // Both used to fail silently: an empty athlete picker with no reason, and
    // the saved-styles option simply missing.
    getList<Athlete>('/api/athletes')
      .then(setAthletes)
      .catch((err) => toast.error(`Could not load your athletes. ${errorMessage(err)}`))
    getList<ExportStyle>('/api/export-styles')
      .then(setStyles)
      .catch((err) => toast.error(`Could not load your saved Excel styles. ${errorMessage(err)}`))
    // A default only; on failure the form simply keeps 4.
    getJson<CoachStyleProfile>('/api/style-profile')
      .then((p) => { if (p?.usable && p.preferredBlockWeeks) setUsualWeeks(p.preferredBlockWeeks) })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (usualWeeks && !weeksTouched) setForm((f) => ({ ...f, weeks: String(usualWeeks) }))
  }, [usualWeeks, weeksTouched])

  const [focus, setFocus] = useState('')
  // A name to use when the coach does not type one: who, what, when.
  const athleteName = athletes.find((a) => a.id === form.athlete_id)?.name
  const focusLabel = { hypertrophy: 'Hypertrophy', strength: 'Strength', peaking: 'Peaking' }[focus] ?? 'Block'
  const startMonth = form.start_date
    ? new Date(`${form.start_date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : ''
  const suggestedName = [athleteName, focusLabel, startMonth].filter(Boolean).join(' · ')

  const weeks = Number(form.weeks)
  const dates = form.start_date && weeks >= 1 && weeks <= 52 ? blockDates(form.start_date, weeks) : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dates) return
    setSaving(true)
    try {
      const program = await sendJson<{ id: string }>('POST', '/api/programs', {
        athlete_id: form.athlete_id,
        name: form.name.trim() || suggestedName,
        focus: focus || null,
        description: form.description,
        status: form.status,
        start_date: dates.start,
        end_date: dates.end,
        export_style_id: styleSourceId === NO_STYLE ? undefined : styleSourceId,
        // The built-in look only applies when no saved coach style is chosen.
        builtin_template: styleSourceId === NO_STYLE ? builtinTemplate : undefined,
      })
      navigate(`/programs/${program.id}`)
    } catch (err) {
      toast.error(`Could not create the program. ${errorMessage(err)}`)
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <BackLink to="/programs">Programs</BackLink>
      <PageHeader title="New Program" />
      <form onSubmit={handleSubmit} className="grid items-start gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Program Details</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-4">
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
                <Label htmlFor="name">Program name</Label>
                {/* Left empty, the suggestion in grey is used. */}
                <Input
                  id="name" maxLength={200}
                  value={form.name}
                  placeholder={suggestedName}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="focus">Training focus</Label>
                <select
                  id="focus"
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">No focus</option>
                  <option value="hypertrophy">Hypertrophy</option>
                  <option value="strength">Strength</option>
                  <option value="peaking">Peaking</option>
                </select>
                <p className="text-xs text-muted-foreground">Used to tailor future program suggestions. Can be changed later.</p>
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
                    Export this program in a saved coach layout instead of a built-in template.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="start">Start date *</Label>
                  <Input id="start" type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="weeks">Weeks *</Label>
                  <Input
                    id="weeks" type="number" min="1" max="52" required
                    value={form.weeks}
                    onChange={(e) => { setWeeksTouched(true); setForm({ ...form, weeks: e.target.value }) }}
                  />
                </div>
              </div>
              {dates && (
                <p className="text-xs text-muted-foreground">
                  <span className="num text-foreground">{dates.start} → {dates.end}</span>
                  {usualWeeks && !weeksTouched && weeks === usualWeeks ? ' · your usual block length' : ''}
                  {dates.start !== form.start_date ? ' · programs start on the Monday of that week' : ''}
                </p>
              )}
              <Button type="submit" disabled={saving || !form.athlete_id || !dates}>{saving ? 'Saving…' : 'Create program'}</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Excel template</CardTitle></CardHeader>
          <CardContent>
            {styleSourceId === NO_STYLE ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Pick the look your athlete’s exported program will have — preview each below.
                </p>
                <TemplatePicker value={builtinTemplate} onChange={setBuiltinTemplate} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This program will export in the selected saved coach style. You can preview it on the
                program page after creating it.
              </p>
            )}
          </CardContent>
        </Card>
      </form>
    </div>
  )
}
