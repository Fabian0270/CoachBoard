import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useProgramData } from '../hooks/useProgramData'
import { useProgramCalendar, useWorkoutByDate } from '../hooks/useProgramCalendar'
import { useWorkoutActions } from '../hooks/useWorkoutActions'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { ArrowLeft, Trash2, CalendarRange, Plus, Loader2, Check, X, Download, SlidersHorizontal, Upload } from 'lucide-react'
import ImportDialog from '../components/ImportDialog'
import {
  type ToggleableColumn,
  type Exercise,
  type Workout,
  type ColKey,
  type ColDef,
  TOGGLEABLE_COLUMNS,
  COLUMN_LABELS,
  DAY_LABELS,
  DEFAULT_COL_WIDTH,
  weeksBetween,
  dayName,
  exerciseValue,
  buildColumns,
} from '../lib/programUtils'

export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { program, setProgram, notFound } = useProgramData(id)
  const [setupForm, setSetupForm] = useState({ start_date: '', weeks: '4' })
  const [savingDuration, setSavingDuration] = useState(false)
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [cellStatus, setCellStatus] = useState<Record<string, 'saving' | 'saved' | 'error'>>({})
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const savedTimers = useRef<Record<string, number>>({})

  const grid = useProgramCalendar(program)
  const workoutByDate = useWorkoutByDate(program)

  const flashCell = (date: string, status: 'saving' | 'saved' | 'error') => {
    setCellStatus((s) => ({ ...s, [date]: status }))
    if (status !== 'saving') {
      if (savedTimers.current[date]) window.clearTimeout(savedTimers.current[date])
      savedTimers.current[date] = window.setTimeout(() => {
        setCellStatus((s) => { const n = { ...s }; delete n[date]; return n })
      }, status === 'error' ? 2500 : 1200)
    }
  }

  const { addExercise, saveExerciseField, deleteExercise, deleteWorkout } = useWorkoutActions(
    id, workoutByDate, setProgram, flashCell,
  )

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return
    setSavingDuration(true)
    try {
      const res = await fetch(`/api/programs/${id}/duration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: setupForm.start_date, weeks: Number(setupForm.weeks) }),
      })
      if (res.ok) {
        const updated = await res.json()
        setProgram((p) => p ? { ...p, ...updated } : p)
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        alert(`Failed to set duration: ${err.error ?? JSON.stringify(err)}`)
      }
    } catch (err) {
      alert(`Network error: ${String(err)}`)
    } finally {
      setSavingDuration(false)
    }
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

  const toggleColumn = async (col: ToggleableColumn) => {
    if (!program || !id) return
    const current = program.enabled_columns ?? TOGGLEABLE_COLUMNS
    const nextSet = current.includes(col) ? current.filter((c) => c !== col) : [...current, col]
    const ordered = TOGGLEABLE_COLUMNS.filter((c) => nextSet.includes(c))
    setProgram({ ...program, enabled_columns: ordered })
    await fetch(`/api/programs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled_columns: ordered }),
    })
  }

  if (notFound) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground">Program not found — it may have been deleted.</p>
        <Link to="/programs" className="text-primary underline">Back to programs</Link>
      </div>
    )
  }
  if (!program) return <div className="text-muted-foreground">Loading...</div>

  const openWorkout = openDate ? workoutByDate.get(openDate) ?? null : null
  const enabledColumns = program.enabled_columns ?? TOGGLEABLE_COLUMNS

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
            <>
              <Button variant="outline" size="sm" onClick={() => setColumnsOpen(true)}>
                <SlidersHorizontal className="h-4 w-4 mr-1" />Columns
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={`/api/programs/${program.id}/export`} download>
                  <Upload className="h-4 w-4 mr-1" />Export
                </a>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <Download className="h-4 w-4 mr-1" />Import
              </Button>
              <Button variant="outline" size="sm" onClick={handleChangeDuration}>
                <CalendarRange className="h-4 w-4 mr-1" />Change duration
              </Button>
            </>
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
                              {status === 'error' && <X className="h-3 w-3 text-destructive" />}
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
        <DialogContent className="w-fit max-w-[95vw]">
          <DialogHeader>
            <DialogTitle>
              {openDate ? `${dayName(openDate)} · ${openDate}` : ''}
            </DialogTitle>
          </DialogHeader>
          {openDate && (
            <ExerciseEditor
              workout={openWorkout}
              enabledColumns={enabledColumns}
              programId={id ?? ''}
              onAdd={() => addExercise(openDate)}
              onSaveField={(exerciseId, patch) => {
                if (openWorkout) saveExerciseField(openDate, openWorkout.id, exerciseId, patch)
              }}
              onDeleteExercise={(exerciseId) => {
                if (openWorkout) deleteExercise(openDate, openWorkout.id, exerciseId)
              }}
              onDeleteWorkout={() => {
                if (openWorkout) deleteWorkout(openWorkout.id, () => setOpenDate(null))
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={columnsOpen} onOpenChange={setColumnsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Columns</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Choose which columns appear in the day editor and the exported sheet. Exercise, Sets and Reps are always shown.
          </p>
          <div className="space-y-1">
            {TOGGLEABLE_COLUMNS.map((col) => {
              const checked = enabledColumns.includes(col)
              return (
                <label
                  key={col}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40 cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleColumn(col)}
                    className="h-4 w-4 accent-primary"
                  />
                  {COLUMN_LABELS[col]}
                </label>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>

      {program.start_date && (
        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          programId={program.id}
          onImported={() => {
            fetch(`/api/programs/${program.id}`)
              .then((r) => r.json())
              .then((data) => setProgram(data))
              .catch(() => {})
          }}
        />
      )}
    </div>
  )
}

interface ExerciseEditorProps {
  workout: Workout | null
  enabledColumns: ToggleableColumn[]
  programId: string
  onAdd: () => void
  onSaveField: (exerciseId: string, patch: Partial<Exercise>) => void
  onDeleteExercise: (exerciseId: string) => void
  onDeleteWorkout: () => void
}

function useColumnWidths(programId: string, columns: ColDef[]): [Record<string, number>, (key: ColKey, width: number) => void] {
  const storageKey = `program-col-widths:${programId}`
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const defaults: Record<string, number> = {}
    columns.forEach((c) => { defaults[c.key] = DEFAULT_COL_WIDTH[c.key] })
    if (!programId) return defaults
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      return { ...defaults, ...stored }
    } catch { return defaults }
  })
  const setWidth = (key: ColKey, width: number) => {
    setWidths((prev) => {
      const next = { ...prev, [key]: width }
      if (programId) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* ignore */ }
      }
      return next
    })
  }
  return [widths, setWidth]
}

function ExerciseEditor({ workout, enabledColumns, programId, onAdd, onSaveField, onDeleteExercise, onDeleteWorkout }: ExerciseEditorProps) {
  const exercises = workout?.exercises ?? []
  const columns = buildColumns(enabledColumns)
  const [widths, setWidth] = useColumnWidths(programId, columns)
  const activeResizeCleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      activeResizeCleanup.current?.()
      activeResizeCleanup.current = null
    }
  }, [])

  const startResize = (key: ColKey) => (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widths[key] ?? DEFAULT_COL_WIDTH[key]
    const onMove = (ev: MouseEvent) => {
      setWidth(key, Math.max(40, startW + (ev.clientX - startX)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      activeResizeCleanup.current = null
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    activeResizeCleanup.current = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            {columns.map((c) => <col key={c.key} style={{ width: widths[c.key] ?? DEFAULT_COL_WIDTH[c.key] }} />)}
            <col style={{ width: 36 }} />
          </colgroup>
          <thead>
            <tr className="bg-muted/50 text-xs text-muted-foreground">
              {columns.map((c) => (
                <th key={c.key} className="relative border-b border-r border-border px-2 py-1.5 text-left font-medium whitespace-nowrap select-none">
                  {c.label}
                  <span
                    onMouseDown={startResize(c.key)}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/60 active:bg-primary/80"
                    aria-hidden
                  />
                </th>
              ))}
              <th className="border-b border-border px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {exercises.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No exercises yet — click "Add exercise" below to start.
                </td>
              </tr>
            )}
            {exercises.map((ex) => (
              <ExerciseRow
                key={ex.id}
                exercise={ex}
                columns={columns}
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
  columns: ColDef[]
  onSave: (patch: Partial<Exercise>) => void
  onDelete: () => void
}

function ExerciseRow({ exercise, columns, onSave, onDelete }: ExerciseRowProps) {
  const initDraft = () => {
    const d: Record<string, string> = {}
    for (const c of columns) d[c.key] = exerciseValue(exercise, c.key)
    return d
  }
  const [draft, setDraft] = useState<Record<string, string>>(initDraft)

  useEffect(() => {
    setDraft(initDraft())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise.id, exercise.name, exercise.sets, exercise.reps, exercise.weight, exercise.rest_time, exercise.intensity, exercise.load_used, exercise.rpe, columns.length])

  const commit = (col: ColDef) => {
    const v = draft[col.key] ?? ''
    if (v === exerciseValue(exercise, col.key)) return
    if (col.key === 'name') {
      onSave({ name: v })
    } else if (col.numeric) {
      const num = v === '' ? null : Number(v)
      if (num !== null && Number.isNaN(num)) return
      onSave({ weight: num })
    } else {
      onSave({ [col.key]: v || null } as Partial<Exercise>)
    }
  }

  const inputCls = "w-full bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary"
  const textareaStyle: React.CSSProperties = { fieldSizing: 'content' } as React.CSSProperties

  return (
    <tr>
      {columns.map((c) => (
        <td key={c.key} className="border-b border-r border-border p-0 align-top">
          {c.numeric ? (
            <input
              type="number"
              min="0"
              step="0.5"
              value={draft[c.key] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
              onBlur={() => commit(c)}
              placeholder={c.placeholder}
              className={inputCls}
            />
          ) : (
            <textarea
              rows={1}
              value={draft[c.key] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
              onBlur={() => commit(c)}
              placeholder={c.placeholder}
              style={textareaStyle}
              className={`${inputCls} resize-none block leading-snug`}
            />
          )}
        </td>
      ))}
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
