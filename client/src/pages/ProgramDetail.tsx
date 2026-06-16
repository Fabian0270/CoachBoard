import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
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
import { ArrowLeft, Trash2, CalendarRange, Plus, Loader2, Check, X, Download, SlidersHorizontal, Upload, BarChart2, Copy, GripVertical } from 'lucide-react'
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
  const [exportToast, setExportToast] = useState(false)
  const exportToastTimer = useRef<number | null>(null)
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

interface ExerciseEditorProps {
  workout: Workout | null
  enabledColumns: ToggleableColumn[]
  programId: string
  sameDayDates: { date: string; weekIndex: number }[]
  onAdd: () => void
  onSaveField: (exerciseId: string, patch: Partial<Exercise>) => void
  onDeleteExercise: (exerciseId: string) => void
  onDeleteWorkout: () => void
  onAddSet: (exerciseId: string) => void
  onCopyDay: (targetDates: string[]) => Promise<void>
  onReorder: (exerciseIds: string[]) => void
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

// Group consecutive exercises that share the same group_id
function buildGroups(exercises: Exercise[]) {
  type Group = { groupId: string | null; exercises: Exercise[] }
  const groups: Group[] = []
  for (const ex of exercises) {
    const gid = ex.group_id ?? null
    const last = groups[groups.length - 1]
    if (gid && last && last.groupId === gid) {
      last.exercises.push(ex)
    } else {
      groups.push({ groupId: gid, exercises: [ex] })
    }
  }
  return groups
}

function ExerciseEditor({ workout, enabledColumns, programId, sameDayDates, onAdd, onSaveField, onDeleteExercise, onDeleteWorkout, onAddSet, onCopyDay, onReorder }: ExerciseEditorProps) {
  const exercises = workout?.exercises ?? []
  const columns = buildColumns(enabledColumns)
  const [widths, setWidth] = useColumnWidths(programId, columns)
  const activeResizeCleanup = useRef<(() => void) | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())
  const [copying, setCopying] = useState(false)

  // Drag-and-drop state
  type DragInfo = { exerciseId: string; mode: 'group' | 'set'; groupId: string | null }
  const draggingRef = useRef<DragInfo | null>(null)
  const [dragging, setDragging] = useState<DragInfo | null>(null)
  // null = no drag, 'end' = insert after all, string = insert before this exercise ID
  const [dropBeforeId, setDropBeforeId] = useState<string | 'end' | null>(null)
  // Lock the table wrapper height during drag so the dialog doesn't resize as
  // placeholder rows appear/disappear, which would cause twitching.
  const tableWrapperRef = useRef<HTMLDivElement>(null)
  const [dragLockedHeight, setDragLockedHeight] = useState<number | null>(null)

  const startGroupDrag = (exerciseId: string, groupId: string | null) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    const info: DragInfo = { exerciseId, mode: 'group', groupId }
    draggingRef.current = info
    const h = tableWrapperRef.current?.getBoundingClientRect().height
    if (h) setDragLockedHeight(h)
    setDragging(info)
  }

  const startSetDrag = (exerciseId: string, groupId: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    const info: DragInfo = { exerciseId, mode: 'set', groupId }
    draggingRef.current = info
    const h = tableWrapperRef.current?.getBoundingClientRect().height
    if (h) setDragLockedHeight(h)
    setDragging(info)
  }

  const stopDrag = () => {
    draggingRef.current = null
    setDragging(null)
    setDropBeforeId(null)
    setDragLockedHeight(null)
  }

  // The editor lives inside a Radix <Dialog> portal (rendered to document.body, outside
  // the React root container). React 18 attaches synthetic event listeners to the root
  // container, so onDragEnd on the grip span never fires in a portal. Register a native
  // document listener instead whenever a drag is in progress.
  useEffect(() => {
    if (!dragging) return
    const handler = () => {
      draggingRef.current = null
      setDragging(null)
      setDropBeforeId(null)
      setDragLockedHeight(null)
    }
    document.addEventListener('dragend', handler, { capture: true })
    return () => document.removeEventListener('dragend', handler, { capture: true })
  }, [dragging]) // eslint-disable-line react-hooks/exhaustive-deps

  // Called by onDragOver on each row — determines where the placeholder appears
  const handleDragOverRow = (ex: Exercise, group: ReturnType<typeof buildGroups>[0]) => (e: React.DragEvent) => {
    const info = draggingRef.current
    if (!info) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const isTopHalf = e.clientY < rect.top + rect.height / 2

    if (info.mode === 'group') {
      const dragGroup = groups.find(g => g.exercises.some(x => x.id === info.exerciseId))
      // Hovering own group — no valid drop, clear placeholder, don't prevent default
      if (!dragGroup || dragGroup === group) { setDropBeforeId(null); return }
      e.preventDefault()
      if (isTopHalf) {
        setDropBeforeId(group.exercises[0].id)
      } else {
        const gi = groups.indexOf(group)
        let next: string | 'end' = 'end'
        for (let k = gi + 1; k < groups.length; k++) {
          if (groups[k] !== dragGroup) { next = groups[k].exercises[0].id; break }
        }
        setDropBeforeId(next)
      }
    } else {
      // Hovering own exercise or wrong group — clear placeholder
      if (group.groupId !== info.groupId || ex.id === info.exerciseId) { setDropBeforeId(null); return }
      e.preventDefault()
      if (isTopHalf) {
        setDropBeforeId(ex.id)
      } else {
        const idx = group.exercises.findIndex(x => x.id === ex.id)
        let next: string | 'end' = 'end'
        for (let k = idx + 1; k < group.exercises.length; k++) {
          if (group.exercises[k].id !== info.exerciseId) { next = group.exercises[k].id; break }
        }
        setDropBeforeId(next)
      }
    }
  }

  const executeDrop = () => {
    const info = draggingRef.current
    if (!info || dropBeforeId === null) { stopDrag(); return }

    if (info.mode === 'group') {
      const dragGroup = groups.find(g => g.exercises.some(x => x.id === info.exerciseId))
      if (!dragGroup) { stopDrag(); return }
      const others = groups.filter(g => g !== dragGroup)
      const insertAt = dropBeforeId === 'end'
        ? others.length
        : others.findIndex(g => g.exercises[0].id === dropBeforeId)
      if (insertAt === -1) { stopDrag(); return }
      const newGroups = [...others.slice(0, insertAt), dragGroup, ...others.slice(insertAt)]
      onReorder(newGroups.flatMap(g => g.exercises.map(x => x.id)))
    } else {
      const group = groups.find(g => g.groupId === info.groupId)
      if (!group) { stopDrag(); return }
      const ids = group.exercises.map(x => x.id)
      const otherIds = ids.filter(id => id !== info.exerciseId)
      const insertAt = dropBeforeId === 'end'
        ? otherIds.length
        : otherIds.indexOf(dropBeforeId)
      if (insertAt === -1) { stopDrag(); return }
      const newIds = [...otherIds.slice(0, insertAt), info.exerciseId, ...otherIds.slice(insertAt)]
      const groupSet = new Set(ids)
      let gi = 0
      onReorder(exercises.map(x => groupSet.has(x.id) ? newIds[gi++] : x.id))
    }
    stopDrag()
  }

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

  const toggleDate = (date: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date); else next.add(date)
      return next
    })
  }

  const handleCopy = async () => {
    if (selectedDates.size === 0) return
    setCopying(true)
    try {
      await onCopyDay([...selectedDates])
      setCopyOpen(false)
      setSelectedDates(new Set())
    } finally {
      setCopying(false)
    }
  }

  const groups = buildGroups(exercises)

  return (
    <div className="space-y-3">
      <div
        ref={tableWrapperRef}
        className="overflow-x-auto rounded-md border border-border"
        style={dragLockedHeight != null ? { height: dragLockedHeight, overflowY: 'auto' } : undefined}
      >
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            {columns.flatMap((c) => {
              const col = <col key={c.key} style={{ width: widths[c.key] ?? DEFAULT_COL_WIDTH[c.key] }} />
              return c.key === 'sets' ? [col, <col key="add-set-col" style={{ width: 24 }} />] : [col]
            })}
            {/* delete action */}
            <col style={{ width: 28 }} />
          </colgroup>
          <thead>
            <tr className="bg-muted/50 text-xs text-muted-foreground">
              {columns.flatMap((c) => {
                const th = (
                  <th key={c.key} className="relative border-b border-r border-border px-2 py-1.5 text-left font-medium whitespace-nowrap select-none">
                    {c.label}
                    <span
                      onMouseDown={startResize(c.key)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/60 active:bg-primary/80"
                      aria-hidden
                    />
                  </th>
                )
                return c.key === 'sets' ? [th, <th key="add-set-col" className="border-b border-r border-border" />] : [th]
              })}
              <th className="border-b border-border px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {exercises.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No exercises yet — click "Add exercise" below to start.
                </td>
              </tr>
            )}
            {groups.map((group, gi) => {
              const isOwnDragGroup = dragging?.mode === 'group' && group.exercises.some(ex => ex.id === dragging.exerciseId)

              return (
                <Fragment key={group.groupId ?? group.exercises[0]?.id ?? gi}>
                  {/* Placeholder before this group during group drag */}
                  {dragging?.mode === 'group' && dropBeforeId === group.exercises[0]?.id && (
                    <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
                  )}

                  {group.exercises.map((ex, i) => {
                    const isDraggedSet = dragging?.mode === 'set' && ex.id === dragging.exerciseId
                    const isValidSetTarget = dragging?.mode === 'set' && group.groupId === dragging.groupId
                    return (
                      <Fragment key={ex.id}>
                        {isValidSetTarget && !isDraggedSet && dropBeforeId === ex.id && (
                          <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
                        )}
                        <ExerciseRow
                          exercise={ex}
                          columns={columns}
                          isSubSet={i > 0}
                          isInGroup={group.groupId !== null}
                          isDragging={isOwnDragGroup || isDraggedSet}
                          onSave={(patch) => onSaveField(ex.id, patch)}
                          onDelete={() => onDeleteExercise(ex.id)}
                          onAddSet={i === group.exercises.length - 1 ? () => onAddSet(ex.id) : undefined}
                          onGroupDragStart={i === 0 ? startGroupDrag(ex.id, group.groupId) : undefined}
                          onSetDragStart={i > 0 && group.groupId ? startSetDrag(ex.id, group.groupId) : undefined}
                          onDragEnd={stopDrag}
                          onDragOverRow={dragging ? handleDragOverRow(ex, group) : undefined}
                          onDropRow={dragging ? executeDrop : undefined}
                        />
                      </Fragment>
                    )
                  })}

                  {/* Placeholder at end of group during set drag */}
                  {dragging?.mode === 'set' && dragging.groupId === group.groupId && dropBeforeId === 'end' && (
                    <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
                  )}
                </Fragment>
              )
            })}
            {/* Placeholder after all groups during group drag */}
            {dragging?.mode === 'group' && dropBeforeId === 'end' && (
              <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: add exercise / clear day / copy to weeks */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4 mr-1" />Add exercise
          </Button>
          {sameDayDates.length > 0 && exercises.length > 0 && !copyOpen && (
            <Button type="button" size="sm" variant="outline" onClick={() => setCopyOpen(true)}>
              <Copy className="h-4 w-4 mr-1" />Copy to weeks…
            </Button>
          )}
        </div>
        {workout && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDeleteWorkout}>
            <Trash2 className="h-4 w-4 mr-1" />Clear day
          </Button>
        )}
      </div>

      {/* Inline copy-to-weeks panel */}
      {copyOpen && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <p className="text-sm font-medium">Copy exercises to:</p>
          <div className="space-y-1.5">
            {sameDayDates.map(({ date, weekIndex }) => (
              <label key={date} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={selectedDates.has(date)}
                  onChange={() => toggleDate(date)}
                />
                Week {weekIndex + 1}
                <span className="text-muted-foreground">{date}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Existing exercises on the target days will be replaced.</p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" disabled={copying || selectedDates.size === 0} onClick={handleCopy}>
              {copying ? 'Copying…' : `Copy to ${selectedDates.size || 0} week${selectedDates.size === 1 ? '' : 's'}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setCopyOpen(false); setSelectedDates(new Set()) }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function PlaceholderRow({ colCount, onDrop }: { colCount: number; onDrop: () => void }) {
  return (
    <tr aria-hidden>
      <td
        colSpan={colCount}
        className="py-0.5 px-1"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onDrop() }}
      >
        <div className="h-7 rounded border-2 border-dashed border-primary/50 bg-primary/5" />
      </td>
    </tr>
  )
}

interface ExerciseRowProps {
  exercise: Exercise
  columns: ColDef[]
  onSave: (patch: Partial<Exercise>) => void
  onDelete: () => void
  onAddSet?: () => void
  isSubSet?: boolean
  isInGroup?: boolean
  isDragging?: boolean
  onGroupDragStart?: (e: React.DragEvent) => void
  onSetDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOverRow?: (e: React.DragEvent) => void
  onDropRow?: () => void
}

function ExerciseRow({ exercise, columns, onSave, onDelete, onAddSet, isSubSet, isInGroup, isDragging, onGroupDragStart, onSetDragStart, onDragEnd, onDragOverRow, onDropRow }: ExerciseRowProps) {
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
  const groupBorder = isInGroup ? 'border-l-2 border-l-primary/30' : ''

  return (
    <tr
      className={isDragging ? 'opacity-30' : undefined}
      onDragOver={onDragOverRow}
      onDrop={onDropRow ? (e) => { e.preventDefault(); onDropRow() } : undefined}
    >
      {columns.flatMap((c) => {
        if (c.key === 'name') {
          return [
            <td key="name" className={`border-b border-r border-border p-0 align-top ${groupBorder}`}>
              {isSubSet ? (
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <span
                    draggable
                    onDragStart={onSetDragStart}
                    onDragEnd={onDragEnd}
                    className="flex-shrink-0 cursor-grab text-muted-foreground/30 hover:text-muted-foreground/60 active:cursor-grabbing"
                  >
                    <GripVertical className="h-3 w-3" />
                  </span>
                  <span className="text-xs text-muted-foreground/40 select-none">↳</span>
                </div>
              ) : (
                <div className="flex items-start">
                  <span
                    draggable
                    onDragStart={onGroupDragStart}
                    onDragEnd={onDragEnd}
                    className="flex-shrink-0 mt-[7px] ml-1 cursor-grab text-muted-foreground/30 hover:text-muted-foreground/60 active:cursor-grabbing"
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </span>
                  <textarea
                    rows={1}
                    value={draft[c.key] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                    onBlur={() => commit(c)}
                    placeholder={c.placeholder}
                    style={textareaStyle}
                    className="flex-1 min-w-0 bg-transparent px-1 py-1.5 text-sm outline-none focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary resize-none block leading-snug"
                  />
                </div>
              )}
            </td>,
          ]
        }
        const cellContent = c.numeric ? (
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
        )
        const mainTd = (
          <td key={c.key} className="border-b border-r border-border p-0 align-top">
            {cellContent}
          </td>
        )
        if (c.key === 'sets') {
          return [
            mainTd,
            <td key="add-set-col" className="border-b border-r border-border p-0 text-center align-middle">
              {onAddSet && (
                <button
                  type="button"
                  onClick={onAddSet}
                  className="p-1 text-muted-foreground hover:text-primary"
                  aria-label="Add set"
                  title="Add set"
                >
                  <Plus className="h-3 w-3" />
                </button>
              )}
            </td>,
          ]
        }
        return [mainTd]
      })}
      <td className="border-b border-border p-0 text-center align-middle">
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-muted-foreground hover:text-destructive"
          aria-label="Delete exercise"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}
