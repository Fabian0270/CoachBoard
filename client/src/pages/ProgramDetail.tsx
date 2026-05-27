import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { ArrowLeft, Trash2, CalendarRange, Plus, Loader2, Check } from 'lucide-react'

interface Exercise {
  id: string
  name: string
  sets: string | null
  reps: string | null
  weight: number | null
  duration: number | null
  distance: number | null
  notes: string | null
  order_index?: number
}

interface Workout {
  id: string
  name: string
  scheduled_date: string | null
  completed_at: string | null
  notes: string | null
  exercises: Exercise[]
}

interface Program {
  id: string
  name: string
  description: string | null
  status: string
  start_date: string | null
  end_date: string | null
  workouts: Workout[]
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function mondayOf(d: Date): Date {
  const day = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1 - day)
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() + diff)
  return monday
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setUTCDate(d.getUTCDate() + days)
  return r
}

function weeksBetween(start: string, end: string): number {
  const s = parseIsoDate(start)
  const e = parseIsoDate(end)
  const diffDays = Math.round((e.getTime() - s.getTime()) / 86400000) + 1
  return Math.max(1, Math.ceil(diffDays / 7))
}

function dayName(date: string): string {
  const d = parseIsoDate(date)
  return DAY_LABELS[(d.getUTCDay() + 6) % 7]
}

export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [program, setProgram] = useState<Program | null>(null)
  const [setupForm, setSetupForm] = useState({ start_date: '', weeks: '4' })
  const [savingDuration, setSavingDuration] = useState(false)
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [cellStatus, setCellStatus] = useState<Record<string, 'saving' | 'saved'>>({})
  const savedTimers = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!id) return
    fetch(`/api/programs/${id}`).then((r) => r.json()).then(setProgram)
  }, [id])

  const grid = useMemo(() => {
    if (!program?.start_date) return null
    const startMonday = mondayOf(parseIsoDate(program.start_date))
    const weeks = program.end_date
      ? weeksBetween(toIsoDate(startMonday), program.end_date)
      : 4
    const rows: { weekIndex: number; days: { date: string; label: number }[] }[] = []
    for (let w = 0; w < weeks; w++) {
      const days: { date: string; label: number }[] = []
      for (let d = 0; d < 7; d++) {
        const date = addDays(startMonday, w * 7 + d)
        days.push({ date: toIsoDate(date), label: date.getUTCDate() })
      }
      rows.push({ weekIndex: w, days })
    }
    return { weeks, rows }
  }, [program?.start_date, program?.end_date])

  const workoutByDate = useMemo(() => {
    const m = new Map<string, Workout>()
    for (const w of program?.workouts ?? []) {
      if (w.scheduled_date) m.set(w.scheduled_date, w)
    }
    return m
  }, [program?.workouts])

  const flashCell = (date: string, status: 'saving' | 'saved') => {
    setCellStatus((s) => ({ ...s, [date]: status }))
    if (status === 'saved') {
      if (savedTimers.current[date]) window.clearTimeout(savedTimers.current[date])
      savedTimers.current[date] = window.setTimeout(() => {
        setCellStatus((s) => { const n = { ...s }; delete n[date]; return n })
      }, 1200)
    }
  }

  const ensureWorkout = async (date: string): Promise<Workout | null> => {
    if (!id) return null
    const existing = workoutByDate.get(date)
    if (existing) return existing
    const res = await fetch(`/api/programs/${id}/workouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: date, scheduled_date: date }),
    })
    if (!res.ok) return null
    const w = await res.json()
    const created: Workout = { ...w, exercises: [] }
    setProgram((p) => p ? { ...p, workouts: [...p.workouts, created] } : p)
    return created
  }

  const updateWorkout = (workoutId: string, mut: (w: Workout) => Workout) => {
    setProgram((p) => p ? { ...p, workouts: p.workouts.map((w) => w.id === workoutId ? mut(w) : w) } : p)
  }

  const addExercise = async (date: string) => {
    if (!id) return
    flashCell(date, 'saving')
    const workout = await ensureWorkout(date)
    if (!workout) { flashCell(date, 'saved'); return }
    const orderIndex = workout.exercises.length
    const res = await fetch(`/api/programs/${id}/workouts/${workout.id}/exercises`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', order_index: orderIndex }),
    })
    if (res.ok) {
      const ex: Exercise = await res.json()
      updateWorkout(workout.id, (w) => ({ ...w, exercises: [...w.exercises, ex] }))
      flashCell(date, 'saved')
    }
  }

  const saveExerciseField = async (date: string, workoutId: string, exerciseId: string, patch: Partial<Exercise>) => {
    if (!id) return
    flashCell(date, 'saving')
    const res = await fetch(`/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      const updated: Exercise = await res.json()
      updateWorkout(workoutId, (w) => ({
        ...w,
        exercises: w.exercises.map((ex) => ex.id === exerciseId ? updated : ex),
      }))
      flashCell(date, 'saved')
    }
  }

  const deleteExercise = async (date: string, workoutId: string, exerciseId: string) => {
    if (!id) return
    flashCell(date, 'saving')
    const res = await fetch(`/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}`, {
      method: 'DELETE',
    })
    if (res.ok || res.status === 404) {
      updateWorkout(workoutId, (w) => ({ ...w, exercises: w.exercises.filter((ex) => ex.id !== exerciseId) }))
      flashCell(date, 'saved')
    }
  }

  const deleteWorkout = async (workoutId: string) => {
    if (!id) return
    if (!confirm('Clear this day? All exercises will be removed.')) return
    const res = await fetch(`/api/programs/${id}/workouts/${workoutId}`, { method: 'DELETE' })
    if (res.ok || res.status === 404) {
      setProgram((p) => p ? { ...p, workouts: p.workouts.filter((w) => w.id !== workoutId) } : p)
      setOpenDate(null)
    }
  }

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return
    setSavingDuration(true)
    const res = await fetch(`/api/programs/${id}/duration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: setupForm.start_date, weeks: Number(setupForm.weeks) }),
    })
    if (res.ok) {
      const updated = await res.json()
      setProgram((p) => p ? { ...p, ...updated } : p)
    }
    setSavingDuration(false)
  }

  const handleDelete = async () => {
    if (!confirm('Delete this program?')) return
    await fetch(`/api/programs/${id}`, { method: 'DELETE' })
    navigate('/programs')
  }

  const handleChangeDuration = () => {
    if (!program) return
    const current = program.start_date && program.end_date
      ? weeksBetween(program.start_date, program.end_date)
      : 4
    setSetupForm({ start_date: program.start_date ?? '', weeks: String(current) })
    setProgram({ ...program, start_date: null, end_date: null })
  }

  if (!program) return <div className="text-muted-foreground">Loading...</div>

  const openWorkout = openDate ? workoutByDate.get(openDate) ?? null : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/programs"><ArrowLeft className="h-5 w-5 text-muted-foreground" /></Link>
          <h1 className="text-3xl font-bold">{program.name}</h1>
          <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
        </div>
        <div className="flex gap-2">
          {program.start_date && (
            <Button variant="outline" size="sm" onClick={handleChangeDuration}>
              <CalendarRange className="h-4 w-4 mr-1" />Change duration
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>
      {program.description && <p className="text-muted-foreground">{program.description}</p>}

      {!grid ? (
        <Card className="max-w-md">
          <CardHeader><CardTitle>Set program duration</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleSetupSubmit} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="start_date">Start date *</Label>
                <Input
                  id="start_date"
                  type="date"
                  required
                  value={setupForm.start_date}
                  onChange={(e) => setSetupForm({ ...setupForm, start_date: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="weeks">Number of weeks *</Label>
                <Input
                  id="weeks"
                  type="number"
                  min="1"
                  max="52"
                  required
                  value={setupForm.weeks}
                  onChange={(e) => setSetupForm({ ...setupForm, weeks: e.target.value })}
                />
              </div>
              <Button type="submit" disabled={savingDuration || !setupForm.start_date}>
                {savingDuration ? 'Saving...' : 'Generate sheet'}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">
            {program.start_date} → {program.end_date} · {grid.weeks} {grid.weeks === 1 ? 'week' : 'weeks'} · click any day to edit
          </div>
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 64 }} />
                {DAY_LABELS.map((d) => <col key={d} />)}
              </colgroup>
              <thead>
                <tr className="bg-muted/50">
                  <th className="border-b border-r border-border px-2 py-1.5 text-xs font-medium text-muted-foreground"></th>
                  {DAY_LABELS.map((d) => (
                    <th key={d} className="border-b border-r border-border px-2 py-1.5 text-xs font-medium text-muted-foreground text-left">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row) => (
                  <tr key={row.weekIndex}>
                    <th className="border-r border-b border-border bg-muted/30 px-2 py-1 text-xs font-medium text-muted-foreground align-top">
                      W{row.weekIndex + 1}
                    </th>
                    {row.days.map((cell) => {
                      const workout = workoutByDate.get(cell.date)
                      const status = cellStatus[cell.date]
                      const exercises = workout?.exercises ?? []
                      return (
                        <td
                          key={cell.date}
                          className="border-r border-b border-border align-top p-0"
                        >
                          <button
                            type="button"
                            onClick={() => setOpenDate(cell.date)}
                            className="block w-full h-full min-h-[88px] text-left px-2 py-1.5 hover:bg-accent/40 focus:bg-accent/40 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary transition-colors"
                          >
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              <span>{cell.label}</span>
                              {status === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
                              {status === 'saved' && <Check className="h-3 w-3 text-green-600" />}
                            </div>
                            {exercises.length === 0 ? (
                              <div className="text-[11px] text-muted-foreground/60 mt-1">+ Add</div>
                            ) : (
                              <ul className="mt-1 space-y-0.5">
                                {exercises.slice(0, 3).map((ex) => (
                                  <li key={ex.id} className="text-[11px] leading-tight truncate">
                                    <span className="font-medium">{ex.name || '—'}</span>
                                    {ex.sets != null && ex.reps != null && (
                                      <span className="text-muted-foreground"> {ex.sets}×{ex.reps}</span>
                                    )}
                                    {ex.weight != null && (
                                      <span className="text-muted-foreground"> @{ex.weight}kg</span>
                                    )}
                                  </li>
                                ))}
                                {exercises.length > 3 && (
                                  <li className="text-[10px] text-muted-foreground">+{exercises.length - 3} more</li>
                                )}
                              </ul>
                            )}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Dialog open={openDate !== null} onOpenChange={(o) => { if (!o) setOpenDate(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {openDate ? `${dayName(openDate)} · ${openDate}` : ''}
            </DialogTitle>
          </DialogHeader>
          {openDate && (
            <ExerciseEditor
              workout={openWorkout}
              onAdd={() => addExercise(openDate)}
              onSaveField={(exerciseId, patch) => {
                if (openWorkout) saveExerciseField(openDate, openWorkout.id, exerciseId, patch)
              }}
              onDeleteExercise={(exerciseId) => {
                if (openWorkout) deleteExercise(openDate, openWorkout.id, exerciseId)
              }}
              onDeleteWorkout={() => {
                if (openWorkout) deleteWorkout(openWorkout.id)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface ExerciseEditorProps {
  workout: Workout | null
  onAdd: () => void
  onSaveField: (exerciseId: string, patch: Partial<Exercise>) => void
  onDeleteExercise: (exerciseId: string) => void
  onDeleteWorkout: () => void
}

function ExerciseEditor({ workout, onAdd, onSaveField, onDeleteExercise, onDeleteWorkout }: ExerciseEditorProps) {
  const exercises = workout?.exercises ?? []
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col />
            <col style={{ width: 60 }} />
            <col style={{ width: 60 }} />
            <col style={{ width: 80 }} />
            <col />
            <col style={{ width: 36 }} />
          </colgroup>
          <thead>
            <tr className="bg-muted/50 text-xs text-muted-foreground">
              <th className="border-b border-r border-border px-2 py-1.5 text-left font-medium">Exercise</th>
              <th className="border-b border-r border-border px-2 py-1.5 text-left font-medium">Sets</th>
              <th className="border-b border-r border-border px-2 py-1.5 text-left font-medium">Reps</th>
              <th className="border-b border-r border-border px-2 py-1.5 text-left font-medium">Weight</th>
              <th className="border-b border-r border-border px-2 py-1.5 text-left font-medium">Notes</th>
              <th className="border-b border-border px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {exercises.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No exercises yet — click "Add exercise" below to start.
                </td>
              </tr>
            )}
            {exercises.map((ex) => (
              <ExerciseRow
                key={ex.id}
                exercise={ex}
                onSave={(patch) => onSaveField(ex.id, patch)}
                onDelete={() => onDeleteExercise(ex.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <Button type="button" size="sm" variant="outline" onClick={onAdd}>
          <Plus className="h-4 w-4 mr-1" />Add exercise
        </Button>
        {workout && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDeleteWorkout}>
            <Trash2 className="h-4 w-4 mr-1" />Clear day
          </Button>
        )}
      </div>
    </div>
  )
}

interface ExerciseRowProps {
  exercise: Exercise
  onSave: (patch: Partial<Exercise>) => void
  onDelete: () => void
}

function asStr(v: unknown): string {
  return v == null ? '' : String(v)
}

function ExerciseRow({ exercise, onSave, onDelete }: ExerciseRowProps) {
  const [draft, setDraft] = useState({
    name: exercise.name ?? '',
    sets: asStr(exercise.sets),
    reps: asStr(exercise.reps),
    weight: exercise.weight?.toString() ?? '',
    notes: exercise.notes ?? '',
  })

  useEffect(() => {
    setDraft({
      name: exercise.name ?? '',
      sets: asStr(exercise.sets),
      reps: asStr(exercise.reps),
      weight: exercise.weight?.toString() ?? '',
      notes: exercise.notes ?? '',
    })
  }, [exercise.id, exercise.name, exercise.sets, exercise.reps, exercise.weight, exercise.notes])

  const commit = (field: 'name' | 'sets' | 'reps' | 'weight' | 'notes') => {
    const v = draft[field]
    if (field === 'name') {
      if (v === (exercise.name ?? '')) return
      onSave({ name: v })
    } else if (field === 'notes') {
      if (v === (exercise.notes ?? '')) return
      onSave({ notes: v || null })
    } else if (field === 'sets' || field === 'reps') {
      if (v === asStr(exercise[field])) return
      onSave({ [field]: v || null } as Partial<Exercise>)
    } else {
      const num = v === '' ? null : Number(v)
      if (num !== null && Number.isNaN(num)) return
      if (num === (exercise.weight ?? null)) return
      onSave({ weight: num })
    }
  }

  const inputCls = "w-full bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary"

  return (
    <tr>
      <td className="border-b border-r border-border p-0">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onBlur={() => commit('name')}
          placeholder="Exercise name"
          className={inputCls}
        />
      </td>
      <td className="border-b border-r border-border p-0">
        <input
          type="text"
          value={draft.sets}
          onChange={(e) => setDraft({ ...draft, sets: e.target.value })}
          onBlur={() => commit('sets')}
          placeholder="e.g. 3 or 3-5"
          className={inputCls}
        />
      </td>
      <td className="border-b border-r border-border p-0">
        <input
          type="text"
          value={draft.reps}
          onChange={(e) => setDraft({ ...draft, reps: e.target.value })}
          onBlur={() => commit('reps')}
          placeholder="e.g. 8 or 8-12"
          className={inputCls}
        />
      </td>
      <td className="border-b border-r border-border p-0">
        <input
          type="number"
          min="0"
          step="0.5"
          value={draft.weight}
          onChange={(e) => setDraft({ ...draft, weight: e.target.value })}
          onBlur={() => commit('weight')}
          className={inputCls}
        />
      </td>
      <td className="border-b border-r border-border p-0">
        <input
          type="text"
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          onBlur={() => commit('notes')}
          className={inputCls}
        />
      </td>
      <td className="border-b border-border p-0 text-center">
        <button
          type="button"
          onClick={onDelete}
          className="p-1.5 text-muted-foreground hover:text-destructive"
          aria-label="Delete exercise"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}
