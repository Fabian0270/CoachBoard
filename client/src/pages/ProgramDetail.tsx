import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useUnsavedWork } from '../lib/unsavedWork'
import { useConfirm } from '../components/ui/confirm-dialog'
import { Trash2, CalendarRange, Loader2, Check, X, Download, SlidersHorizontal, Upload, BarChart2, GripVertical, PlayCircle, Mail, ChevronDown, Eye, Film } from 'lucide-react'
import { BackLink } from '../components/PageHeader'
import DayAttachments from '../components/discord/DayAttachments'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import ImportDialog from '../components/ImportDialog'
import SendProgramDialog from '../components/SendProgramDialog'
import PreviewProgramDialog from '../components/PreviewProgramDialog'
import ExerciseEditor from '../components/program-detail/ExerciseEditor'
import type { SuggestionGoal } from 'coachboard-shared'
import {
  type ToggleableColumn,
  TOGGLEABLE_COLUMNS,
  COLUMN_LABELS,
  DAY_LABELS,
  weeksBetween,
  dayName,
  type Program,
} from '../lib/programUtils'
import { errorMessage, getJson } from '../lib/api'
import LoadError from '../components/LoadError'

export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { program, setProgram, notFound, loadError, reload } = useProgramData(id)
  const [setupForm, setSetupForm] = useState({ start_date: '', weeks: '4' })
  const [savingDuration, setSavingDuration] = useState(false)
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [cellStatus, setCellStatus] = useState<Record<string, 'saving' | 'saved' | 'error'>>({})
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportToast, setExportToast] = useState(false)
  const exportToastTimer = useRef<number | null>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const savedTimers = useRef<Record<string, number>>({})

  const [dayDragSource, setDayDragSource] = useState<string | null>(null)
  const [dayDragOver, setDayDragOver] = useState<string | null>(null)

  const grid = useProgramCalendar(program)
  const workoutByDate = useWorkoutByDate(program)

  // Discord form-check videos confirmed onto this program's days.
  const [discordMedia, setDiscordMedia] = useState<DiscordMediaItem[]>([])
  const loadDiscordMedia = async () => {
    if (!id) return
    try {
      const res = await fetch(`/api/discord/media?programId=${id}&limit=500`)
      if (res.ok) {
        const data = await res.json()
        setDiscordMedia(data.items ?? [])
      }
    } catch { /* offline — attachments simply don't render */ }
  }
  useEffect(() => { void loadDiscordMedia() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const mediaByWorkoutId = useMemo(() => {
    const map = new Map<string, DiscordMediaItem[]>()
    for (const m of discordMedia) {
      if (!m.workoutId) continue
      const list = map.get(m.workoutId) ?? []
      list.push(m)
      map.set(m.workoutId, list)
    }
    return map
  }, [discordMedia])

  useEffect(() => {
    if (!exportMenuOpen) return
    const close = () => setExportMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [exportMenuOpen])

  const flashCell = (date: string, status: 'saving' | 'saved' | 'error') => {
    setCellStatus((s) => ({ ...s, [date]: status }))
    if (status !== 'saving') {
      if (savedTimers.current[date]) window.clearTimeout(savedTimers.current[date])
      savedTimers.current[date] = window.setTimeout(() => {
        setCellStatus((s) => { const n = { ...s }; delete n[date]; return n })
      }, status === 'error' ? 2500 : 1200)
    }
  }

  const {
    addExercise, saveExerciseField, deleteExercise, deleteWorkout, addSet, reorderExercises,
    failedEdits, retryFailedEdits,
  } = useWorkoutActions(
    id, workoutByDate, setProgram, flashCell,
    // One toast per failure. The 2.5-second cell flash on its own was easy to
    // miss and cleared itself, which is how edits went missing unnoticed.
    (message) => toast.error(message),
  )

  const unsavedCount = Object.keys(failedEdits).length
  // Edits that did not save live only in this page; closing the window loses them.
  useUnsavedWork('program-edits', unsavedCount > 0)
  const [retrying, setRetrying] = useState(false)

  const retryUnsaved = async () => {
    setRetrying(true)
    try {
      const { recovered, stillFailing } = await retryFailedEdits()
      if (stillFailing === 0) {
        toast.success(`Saved ${recovered} change${recovered === 1 ? '' : 's'}.`)
      } else if (recovered > 0) {
        toast.error(`Saved ${recovered}, but ${stillFailing} still could not be saved.`)
      } else {
        toast.error('Still could not save. Your changes are kept here until they do.')
      }
    } finally {
      setRetrying(false)
    }
  }

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

  // A failed reload used to put a 500's error object in place of the program.
  // Now the page keeps what it had and says the view may be out of date.
  const reloadProgram = async () => {
    if (!id) return
    try {
      setProgram(await getJson<Program>(`/api/programs/${encodeURIComponent(id)}`))
    } catch (err) {
      toast.error(`The change was saved, but the program could not be refreshed. ${errorMessage(err)}`)
    }
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
  if (!program && loadError) return <LoadError what="this program" message={loadError} onRetry={reload} />
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
    <div className="mx-auto max-w-[1400px] space-y-6">
      <BackLink to="/programs">Programs</BackLink>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{program.name}</h1>
          <Badge variant={program.status === 'active' ? 'default' : 'secondary'} className="capitalize">{program.status}</Badge>
          <select
            value={program.focus ?? ''}
            onChange={(e) => handleSetFocus(e.target.value)}
            className="h-6 cursor-pointer rounded-full border bg-transparent px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
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
        <div className="flex flex-wrap items-center gap-1.5">
          {program.start_date && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setColumnsOpen(true)}>
                <SlidersHorizontal className="h-4 w-4" />Columns
              </Button>
              <Button variant="ghost" size="sm" onClick={handleChangeDuration}>
                <CalendarRange className="h-4 w-4" />Duration
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
                <Download className="h-4 w-4" />Import
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/programs/${program.id}/report`}>
                  <BarChart2 className="h-4 w-4" />Report
                </Link>
              </Button>
              <span aria-hidden className="mx-1 h-5 w-px bg-border" />
              <div className="relative" ref={exportMenuRef}>
                <Button size="sm" onClick={(e) => { e.stopPropagation(); setExportMenuOpen((v) => !v) }}>
                  <Upload className="h-4 w-4" />Export<ChevronDown className="h-4 w-4 -mr-0.5 opacity-70" />
                </Button>
                {exportMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-20 min-w-[200px] rounded-lg border bg-popover py-1 shadow-xl shadow-black/20" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => { setExportMenuOpen(false); setPreviewOpen(true) }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                    >
                      <Eye className="h-4 w-4" />Preview Excel
                    </button>
                    <button
                      type="button"
                      onClick={() => { setExportMenuOpen(false); handleExport() }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                    >
                      <Download className="h-4 w-4" />Download as Excel
                    </button>
                    <button
                      type="button"
                      onClick={() => { setExportMenuOpen(false); setEmailOpen(true) }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                    >
                      <Mail className="h-4 w-4" />Email to athlete
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            aria-label="Delete program"
            title="Delete program"
            className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {program.description && <p className="max-w-3xl text-sm text-muted-foreground">{program.description}</p>}

      {/* Stays until the edits actually land. The old 2.5-second cell flash was
          the only signal a save had failed, and it cleared itself while the
          typed value stayed on screen — so a lost edit looked exactly like a
          saved one. This cannot be missed and cannot time out. */}
      {unsavedCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <X className="h-4 w-4 shrink-0 text-destructive" />
          <span>
            <span className="font-medium">
              {unsavedCount} change{unsavedCount === 1 ? '' : 's'} could not be saved.
            </span>{' '}
            What you typed is still here, but it is not stored yet — don&apos;t close this program
            until it is.
          </span>
          <Button size="sm" variant="outline" onClick={retryUnsaved} disabled={retrying}>
            {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {retrying ? 'Trying…' : 'Try again'}
          </Button>
        </div>
      )}

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
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="num text-foreground">{program.start_date} → {program.end_date}</span>
            <span><span className="num text-foreground">{grid.weeks}</span> {grid.weeks === 1 ? 'week' : 'weeks'}</span>
            <span>Click any day to edit · drag a day to move it</span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[640px] border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 56 }} />
                {DAY_LABELS.map((d) => <col key={d} />)}
              </colgroup>
              <thead>
                <tr>
                  <th className="border-b border-r border-border px-2 py-2 text-[11px] font-medium text-muted-foreground"></th>
                  {DAY_LABELS.map((d) => (
                    <th key={d} className="border-b border-r border-border px-2.5 py-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground last:border-r-0">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row) => (
                  <tr key={row.weekIndex} className="[&:last-child>*]:border-b-0">
                    <th className="num border-b border-r border-border px-2 py-2 align-top text-[11px] font-medium text-muted-foreground">
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
                          className={`border-r border-b border-border align-top p-0 transition-colors last:border-r-0 ${
                            isDragSource ? 'opacity-40' :
                            isDragOver ? (workout ? 'ring-2 ring-inset ring-warning bg-warning/10' : 'ring-2 ring-inset ring-primary/50 bg-primary/5') :
                            ''
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setOpenDate(cell.date)}
                            className={`group/cell block h-full min-h-[92px] w-full px-2.5 py-2 text-left transition-colors duration-150 ease-smooth hover:bg-primary/[0.06] focus:bg-primary/[0.06] focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary ${
                              exercises.length > 0 ? 'shadow-[inset_2px_0_0_hsl(var(--primary)/0.55)]' : ''
                            }`}
                          >
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              <span className="num">{cell.label}</span>
                              <span className="flex items-center gap-0.5">
                                {workout && (mediaByWorkoutId.get(workout.id)?.length ?? 0) > 0 && (
                                  <span
                                    className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 text-[9px] font-semibold text-primary"
                                    title="Form-check videos from Discord"
                                  >
                                    <Film className="h-2.5 w-2.5" />
                                    {mediaByWorkoutId.get(workout.id)!.length}
                                  </span>
                                )}
                                {exercises.length > 0 && !dayDragSource && (
                                  <GripVertical className="h-2.5 w-2.5 text-muted-foreground/30" />
                                )}
                                {status === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
                                {status === 'saved' && <Check className="h-3 w-3 text-success" />}
                                {status === 'error' && <X className="h-3 w-3 text-destructive" />}
                              </span>
                            </div>
                            {exercises.length === 0 ? (
                              <div className="mt-1 text-[11px] text-muted-foreground/40 transition-colors group-hover/cell:text-muted-foreground">+ Add</div>
                            ) : (
                              <ul className="mt-1.5 space-y-1">
                                {exercises.slice(0, 3).map((ex) => (
                                  <li key={ex.id} className="truncate text-[11.5px] leading-tight">
                                    <span className="font-medium">{ex.name || '—'}</span>
                                    {ex.sets != null && ex.reps != null && (
                                      <span className="num text-muted-foreground"> {ex.sets}×{ex.reps}</span>
                                    )}
                                    {ex.weight != null && (
                                      <span className="num text-muted-foreground"> @{ex.weight}kg</span>
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
              // Marks the exact cells that did not save, so the banner's count
              // maps to something the coach can actually find on the page.
              unsavedKeys={new Set(Object.keys(failedEdits))}
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
                if (!id || !openDate) return false
                // A refused copy used to close the dialog exactly as a successful
                // one did, so the coach believed days had been filled that were not.
                try {
                  const res = await fetch(`/api/programs/${id}/copy-day`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sourceDate: openDate, targetDates }),
                  })
                  if (!res.ok) {
                    toast.error(`Could not copy the day (the server said ${res.status}). Nothing was changed.`)
                    return false
                  }
                } catch {
                  toast.error('CoachBoard could not reach its own server, so the day was not copied.')
                  return false
                }
                await reloadProgram()
                return true
              }}
            />
          )}
          {openWorkout && (
            <DayAttachments
              items={mediaByWorkoutId.get(openWorkout.id) ?? []}
              onDetached={() => void loadDiscordMedia()}
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
          onImported={() => { void reloadProgram() }}
        />
      )}

      {program.start_date && (
        <SendProgramDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          programId={program.id}
          programName={program.name}
          athleteId={program.athlete_id ?? null}
        />
      )}

      {program.start_date && (
        <PreviewProgramDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          programId={program.id}
          programName={program.name}
          onDownload={handleExport}
        />
      )}

      {exportToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border bg-popover px-4 py-3 text-sm font-medium shadow-xl shadow-black/20">
          <Check className="h-4 w-4 text-success" />
          Program exported successfully
        </div>
      )}
    </div>
  )
}
