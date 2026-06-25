import { useMemo, useRef, useState } from 'react'
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
import { useToast } from '../components/ui/toast'
import { useConfirm } from '../components/ui/confirm-dialog'
import { ArrowLeft, Trash2, CalendarRange, Loader2, Check, X, Download, SlidersHorizontal, Upload, BarChart2, GripVertical, PlayCircle } from 'lucide-react'
import ImportDialog from '../components/ImportDialog'
import ExerciseEditor from '../components/program-detail/ExerciseEditor'
import type { SuggestionGoal } from 'coachboard-shared'
import {
  type ToggleableColumn,
  TOGGLEABLE_COLUMNS,
  COLUMN_LABELS,
  DAY_LABELS,
  weeksBetween,
  dayName,
} from '../lib/programUtils'

export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { program, setProgram, notFound } = useProgramData(id)
  const [setupForm, setSetupForm] = useState({ start_date: '', weeks: '4' })
  const [savingDuration, setSavingDuration] = useState(false)
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [cellStatus, setCellStatus] = useState<Record<string, 'saving' | 'saved' | 'error'>>({})
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportToast, setExportToast] = useState(false)
  const exportToastTimer = useRef<number | null>(null)
  const savedTimers = useRef<Record<string, number>>({})

  const [dayDragSource, setDayDragSource] = useState<string | null>(null)
  const [dayDragOver, setDayDragOver] = useState<string | null>(null)

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

  const { addExercise, saveExerciseField, deleteExercise, deleteWorkout, addSet, reorderExercises } = useWorkoutActions(
    id, workoutByDate, setProgram, flashCell,
  )

  // Dates for the same day-of-week across all weeks (excluding openDate itself)
  const sameDayDates = useMemo<{ date: string; weekIndex: number }[]>(() => {
    if (!grid || !openDate) return []
    let colIndex = -1
    for (const row of grid.rows) {
      const idx = row.days.findIndex((d) => d.date === openDate)
      if (idx !== -1) { colIndex = idx; break }
    }
    if (colIndex === -1) return []
    return grid.rows
      .filter((row) => row.days[colIndex]?.date !== openDate)
      .map((row) => ({ date: row.days[colIndex].date, weekIndex: row.weekIndex }))
  }, [grid, openDate])

  const reloadProgram = async () => {
    if (!id) return
    const data = await fetch(`/api/programs/${id}`).then((r) => r.json()).catch(() => null)
    if (data) setProgram(data)
  }

  const handleDayDrop = async (targetDate: string) => {
    if (!dayDragSource || !id) return
    const sourceDate = dayDragSource
    setDayDragSource(null)
    setDayDragOver(null)
    const res = await fetch(`/api/programs/${id}/move-day`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDate, targetDate }),
    })
    if (res.ok) await reloadProgram()
  }

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
        toast.error(`Failed to set duration: ${err.error ?? JSON.stringify(err)}`)
      }
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
    } finally {
      setSavingDuration(false)
    }
  }

  const handleDelete = async () => {
    if (!(await confirm({ title: 'Delete this program?', confirmLabel: 'Delete', destructive: true }))) return
    await fetch(`/api/programs/${id}`, { method: 'DELETE' })
    navigate('/programs')
  }

  const handleActivateDraft = async () => {
    if (!program || !id) return
    const res = await fetch(`/api/programs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    if (res.ok) {
      const updated = await res.json()
      setProgram((p) => p ? { ...p, ...updated } : p)
    }
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

  const handleSetFocus = async (value: string) => {
    if (!program) return
    const next = value === '' ? null : (value as SuggestionGoal)
    const res = await fetch(`/api/programs/${program.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ focus: next }),
    })
    if (res.ok) setProgram((p) => (p ? { ...p, focus: next } : p))
  }

  const handleExport = () => {
    const a = document.createElement('a')
    a.href = `/api/programs/${program.id}/export`
    a.download = ''
    a.click()
    if (exportToastTimer.current) window.clearTimeout(exportToastTimer.current)
    setExportToast(true)
    exportToastTimer.current = window.setTimeout(() => setExportToast(false), 3000)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/programs"><ArrowLeft className="h-5 w-5 text-muted-foreground" /></Link>
          <h1 className="text-3xl font-bold">{program.name}</h1>
          <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
          <select
            value={program.focus ?? ''}
            onChange={(e) => handleSetFocus(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-xs text-muted-foreground"
            title="Training focus — used to tailor future program suggestions"
          >
            <option value="">No focus</option>
            <option value="hypertrophy">Hypertrophy</option>
            <option value="strength">Strength</option>
            <option value="peaking">Peaking</option>
          </select>
          {program.status === 'draft' && (
            <Button size="sm" onClick={handleActivateDraft}>
              <PlayCircle className="h-4 w-4 mr-1.5" />
              Turn into active
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {program.start_date && (
            <>
              <Button variant="outline" size="sm" onClick={() => setColumnsOpen(true)}>
                <SlidersHorizontal className="h-4 w-4 mr-1" />Columns
              </Button>
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Upload className="h-4 w-4 mr-1" />Export
              </Button>
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <Download className="h-4 w-4 mr-1" />Import
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/programs/${program.id}/report`}>
                  <BarChart2 className="h-4 w-4 mr-1" />Report
                </Link>
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
                      const isDragSource = dayDragSource === cell.date
                      const isDragOver = dayDragOver === cell.date
                      return (
                        <td
                          key={cell.date}
                          draggable={exercises.length > 0}
                          onDragStart={exercises.length > 0 ? (e) => {
                            e.dataTransfer.effectAllowed = 'move'
                            setDayDragSource(cell.date)
                          } : undefined}
                          onDragOver={dayDragSource && !isDragSource ? (e) => {
                            e.preventDefault()
                            if (!isDragOver) setDayDragOver(cell.date)
                          } : undefined}
                          onDragLeave={(e) => {
                            if (isDragOver && !e.currentTarget.contains(e.relatedTarget as Node | null))
                              setDayDragOver(null)
                          }}
                          onDrop={dayDragSource && !isDragSource ? (e) => {
                            e.preventDefault()
                            handleDayDrop(cell.date)
                          } : undefined}
                          onDragEnd={() => { setDayDragSource(null); setDayDragOver(null) }}
                          className={`border-r border-b border-border align-top p-0 transition-colors ${
                            isDragSource ? 'opacity-40' :
                            isDragOver ? (workout ? 'ring-2 ring-inset ring-amber-400 bg-amber-500/10' : 'ring-2 ring-inset ring-primary/50 bg-primary/5') :
                            ''
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setOpenDate(cell.date)}
                            className="block w-full h-full min-h-[88px] text-left px-2 py-1.5 hover:bg-accent/40 focus:bg-accent/40 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary transition-colors"
                          >
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              <span>{cell.label}</span>
                              <span className="flex items-center gap-0.5">
                                {exercises.length > 0 && !dayDragSource && (
                                  <GripVertical className="h-2.5 w-2.5 text-muted-foreground/30" />
                                )}
                                {status === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
                                {status === 'saved' && <Check className="h-3 w-3 text-green-600 dark:text-green-400" />}
                                {status === 'error' && <X className="h-3 w-3 text-destructive" />}
                              </span>
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
              sameDayDates={sameDayDates}
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
              onAddSet={(exerciseId) => {
                if (openWorkout) addSet(openDate, openWorkout.id, exerciseId)
              }}
              onReorder={(exerciseIds) => {
                if (openWorkout) reorderExercises(openDate, openWorkout.id, exerciseIds)
              }}
              onCopyDay={async (targetDates) => {
                if (!id || !openDate) return
                await fetch(`/api/programs/${id}/copy-day`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sourceDate: openDate, targetDates }),
                })
                await reloadProgram()
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

      {exportToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-green-600 px-4 py-3 text-sm font-medium text-white shadow-lg">
          <Check className="h-4 w-4" />
          Program exported successfully
        </div>
      )}
    </div>
  )
}
