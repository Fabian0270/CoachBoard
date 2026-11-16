import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useProgramData } from '../hooks/useProgramData'
import { useProgramCalendar, useWorkoutByDate } from '../hooks/useProgramCalendar'
import { useWorkoutActions } from '../hooks/useWorkoutActions'
import { useDayOperations, dayHasResults } from '../hooks/useDayOperations'
import { useMenuKeys } from '../hooks/useMenuKeys'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { useToast } from '../components/ui/toast'
import { useUnsavedWork } from '../lib/unsavedWork'
import { useConfirm } from '../components/ui/confirm-dialog'
import { Trash2, Copy, Pencil, CalendarRange, Loader2, Check, X, Download, SlidersHorizontal, Upload, BarChart2, GripVertical, PlayCircle, Mail, ChevronDown, ChevronLeft, ChevronRight, Eye, Film } from 'lucide-react'
import { BackLink } from '../components/PageHeader'
import DayAttachments from '../components/discord/DayAttachments'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import ImportDialog from '../components/ImportDialog'
import SendProgramDialog from '../components/SendProgramDialog'
import PreviewProgramDialog from '../components/PreviewProgramDialog'
import ExerciseEditor, { type CopyWeek } from '../components/program-detail/ExerciseEditor'
import DayPreview from '../components/program-detail/DayPreview'
import type { SuggestionGoal } from 'coachboard-shared'
import {
  type ToggleableColumn,
  TOGGLEABLE_COLUMNS,
  COLUMN_LABELS,
  DAY_LABELS,
  weeksBetween,
  planDurationChange,
  type Program,
} from '../lib/programUtils'
import { errorMessage, getJson, sendJson } from '../lib/api'
import { localToday } from '../lib/dates'
import LoadError from '../components/LoadError'

/**
 * One page per program. Going straight from one program to another kept this
 * page mounted: until the new program loaded it showed the previous one's
 * calendar under the new address, so a quick click opened a day of the old
 * program and its edits were sent to the new one. Keyed by id, the page starts
 * over for each program — open day, clipboard and undo included.
 */
export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>()
  return <ProgramPage key={id} />
}

function ProgramPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { program, setProgram, notFound, loadError, reload } = useProgramData(id)
  const [setupForm, setSetupForm] = useState({ start_date: '', weeks: '4' })
  const [savingDuration, setSavingDuration] = useState(false)
  const [durationOpen, setDurationOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  /** The week whose W-label menu is open. */
  const [weekMenu, setWeekMenu] = useState<number | null>(null)
  // The shortcut handler is registered once; this keeps it on the latest program.
  const handleChangeDurationRef = useRef<() => void>(() => {})
  const [detailsForm, setDetailsForm] = useState({ name: '', description: '' })
  const [savingDetails, setSavingDetails] = useState(false)
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

  const exportMenu = useMenuKeys(exportMenuOpen, () => setExportMenuOpen(false))
  const weekMenuKeys = useMenuKeys(weekMenu !== null, () => setWeekMenu(null))

  // Shortcuts for the buttons at the top of the program. Only while nothing
  // else is open, so they never reach into a dialog or a menu. Delete has no
  // shortcut on purpose: it is one press from losing a whole program.
  useEffect(() => {
    if (!program?.start_date || !id) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      const key = e.key.toLowerCase()
      const act =
        !e.shiftKey && key === 'e' ? () => setExportMenuOpen(true)
        : !e.shiftKey && key === 'i' ? () => setImportOpen(true)
        : !e.shiftKey && key === 'r' ? () => navigate(`/programs/${id}/report`)
        : e.shiftKey && key === 'c' ? () => setColumnsOpen(true)
        : e.shiftKey && key === 'd' ? () => handleChangeDurationRef.current()
        : null
      if (!act) return
      e.preventDefault()
      act()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [program?.start_date, id, navigate])

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
    addExercise, saveExerciseField, deleteExercise, addSet, duplicateExercise, reorderExercises,
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

  // Every day of the program as a place the open day could be copied to.
  const copyGrid = useMemo<CopyWeek[]>(() => {
    if (!grid || !openDate) return []
    const sourceCol = grid.rows.map((r) => r.days.findIndex((d) => d.date === openDate)).find((i) => i !== -1) ?? -1
    return grid.rows.map((row) => ({
      weekIndex: row.weekIndex,
      days: row.days.map((d, col) => {
        const w = workoutByDate.get(d.date)
        return {
          date: d.date,
          weekday: DAY_LABELS[col],
          isSource: d.date === openDate,
          sameWeekday: col === sourceCol,
          occupied: !!w && w.exercises.length > 0,
          hasResults: dayHasResults(w),
        }
      }),
    }))
  }, [grid, openDate, workoutByDate])

  // The coach's own exercise names, for the suggestions in the day editor.
  // Loaded once per visit; on failure the built-in list still suggests.
  const [ownExerciseNames, setOwnExerciseNames] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    getJson<{ name: string }[]>('/api/programs/exercise-names')
      .then((rows) => { if (!cancelled && Array.isArray(rows)) setOwnExerciseNames(rows.map((r) => r.name)) })
      .catch(() => { /* a convenience: the built-in names are still offered */ })
    return () => { cancelled = true }
  }, [])

  // ── Moving between days while one is open ───────────────────────────────
  const allDates = useMemo(() => (grid ? grid.rows.flatMap((r) => r.days.map((d) => d.date)) : []), [grid])
  const lastOpenDate = useRef<string | null>(null)
  if (openDate) lastOpenDate.current = openDate

  /** Whether there is a day `step` calendar days away inside the program. */
  const canGoToDay = (step: number): boolean => {
    const i = openDate ? allDates.indexOf(openDate) : -1
    return i !== -1 && i + step >= 0 && i + step < allDates.length
  }
  /** Next / previous CALENDAR day, empty or not; ±7 is the same weekday. */
  const goToDay = (step: number) => {
    if (!openDate || !canGoToDay(step)) return
    setOpenDate(allDates[allDates.indexOf(openDate) + step])
  }
  /** "16 Nov" */
  const shortDate = (date: string): string =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

  /** "Mon W2" — how a day is named in messages. */
  const shortDayLabel = (date: string): string => {
    const i = allDates.indexOf(date)
    return i === -1 ? date : `${DAY_LABELS[i % 7]} W${Math.floor(i / 7) + 1}`
  }

  const days = useDayOperations({
    programId: id,
    workoutByDate,
    setProgram,
    mediaIdsFor: (workoutId) => (mediaByWorkoutId.get(workoutId) ?? []).map((m) => m.id),
    onMediaChanged: () => void loadDiscordMedia(),
    labelFor: shortDayLabel,
  })

  // ── The calendar from the keyboard ──────────────────────────────────────
  // One day is "current": the only one Tab stops on, and where the arrow keys
  // start from. Without that, Tab would have to cross every day of the block.
  const [currentDay, setCurrentDay] = useState<string | null>(null)
  // Day lookups stay inside THIS calendar. A dialog closing after the page had
  // moved on to another program found a day with the same date there and
  // focused it (seen in the tests, where one screen follows another).
  const calendarRef = useRef<HTMLDivElement>(null)
  // Where the keyboard starts when no day has been visited yet: today, if the
  // program is running, otherwise its first day.
  const today = localToday()
  const startDay = allDates.includes(today) ? today : allDates[0] ?? null
  const tabStopDay = currentDay && allDates.includes(currentDay) ? currentDay : startDay
  const focusDay = (date: string) => {
    setCurrentDay(date)
    calendarRef.current?.querySelector<HTMLElement>(`[data-day="${date}"]`)?.focus()
  }

  // Arrow keys work as soon as the program is on screen. Before, nothing had
  // the focus until a day was clicked, so the first arrow press scrolled the
  // page instead — keyboard use started with the mouse. Now a press with
  // nothing focused lands on the current day; the next one moves from there.
  // Left alone while anything else has the focus (a button, a field) or while a
  // dialog or menu is open, where the arrows mean something else.
  // The whole-day preview shown when the pointer rests on a cell.
  const [preview, setPreview] = useState<{ date: string; rect: DOMRect } | null>(null)
  const previewTimer = useRef<number | null>(null)
  const showPreviewSoon = (date: string, el: HTMLElement) => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(() => setPreview({ date, rect: el.getBoundingClientRect() }), 450)
  }
  const hidePreview = () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    previewTimer.current = null
    setPreview(null)
  }
  useEffect(() => () => { if (previewTimer.current) window.clearTimeout(previewTimer.current) }, [])

  const focusDayRef = useRef(focusDay)
  focusDayRef.current = focusDay
  useEffect(() => {
    if (!tabStopDay) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.key.startsWith('Arrow') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const active = document.activeElement
      if (active && active !== document.body && active !== document.documentElement) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      e.preventDefault()
      focusDayRef.current(tabStopDay)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabStopDay])
  const onDayKeyDown = (e: React.KeyboardEvent, date: string) => {
    const i = allDates.indexOf(date)
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (step !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const to = allDates[i + step]
      if (to) focusDay(to)
      return
    }
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); days.copyToClipboard(date); return }
    if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); days.cutToClipboard(date); return }
    if (ctrl && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      void days.paste(date).then(() => focusDay(date))
      return
    }
    if (ctrl && e.key.toLowerCase() === 'z') {
      if (days.undoLast()) e.preventDefault()
      return
    }
    if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      void days.clearDay(date).then(() => focusDay(date))
      return
    }
    if (e.key === 'Escape' && days.clipboard) days.clearClipboard()
  }

  // ── A whole week at a time ──────────────────────────────────────────────
  const [copyWeekFrom, setCopyWeekFrom] = useState<number | null>(null)
  const [copyWeekTo, setCopyWeekTo] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (weekMenu === null) return
    const close = () => setWeekMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [weekMenu])
  const weekDates = (w: number) => grid?.rows[w]?.days.map((d) => d.date) ?? []
  const weekHasResults = (w: number) => weekDates(w).some((d) => dayHasResults(workoutByDate.get(d)))
  const weekHasExercises = (w: number) => weekDates(w).some((d) => (workoutByDate.get(d)?.exercises.length ?? 0) > 0)
  const runCopyWeek = async () => {
    if (copyWeekFrom === null) return
    const from = weekDates(copyWeekFrom)
    const targets = [...copyWeekTo].sort((a, b) => a - b)
    const pairs = targets.flatMap((w) => weekDates(w).map((target, col) => ({ source: from[col], target })))
    const done = `Week ${copyWeekFrom + 1} copied to week${targets.length === 1 ? '' : 's'} ${targets.map((w) => w + 1).join(', ')}`
    if (await days.copyDays(pairs, done)) setCopyWeekFrom(null)
  }

  /** "Week 3 · Monday · 2 Dec" — the week is what a coach thinks in. */
  const dayTitle = (date: string): string => {
    const i = allDates.indexOf(date)
    // English names on purpose: the app is in English, and the system locale
    // would give "Week 3 · måndag" on a Swedish machine.
    const d = new Date(`${date}T00:00:00Z`)
    const weekday = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })
    const short = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    return `${i === -1 ? '' : `Week ${Math.floor(i / 7) + 1} · `}${weekday} · ${short}`
  }

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

  // Dragging onto an occupied day swaps the two. It used to do so without a
  // word, and a refused move did nothing at all; now it says what happened and
  // offers Undo (see useDayOperations).
  // Holding Ctrl while dropping copies the day instead of moving it.
  const handleDayDrop = async (targetDate: string, copy: boolean) => {
    if (!dayDragSource) return
    const sourceDate = dayDragSource
    setDayDragSource(null)
    setDayDragOver(null)
    if (!copy) { void days.moveDay(sourceDate, targetDate); return }
    if (!(await days.confirmLosingResults([targetDate], 'Replace'))) return
    void days.copyDays(
      [{ source: sourceDate, target: targetDate }],
      `${shortDayLabel(sourceDate)} copied to ${shortDayLabel(targetDate)}`,
    )
  }

  // What the dates in the duration form would do to the training days, worked
  // out before anything is sent so the coach is asked about what is at stake.
  const durationPlan = program && setupForm.start_date && Number(setupForm.weeks) >= 1
    ? planDurationChange(program, setupForm.start_date, Number(setupForm.weeks))
    : null

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id || !durationPlan) return
    const removed = durationPlan.outside
    if (removed.length > 0) {
      const withResults = removed.filter((w) => dayHasResults(w)).length
      const ok = await confirm({
        title: `Remove ${removed.length} training day${removed.length === 1 ? '' : 's'}?`,
        description:
          `${removed.length === 1 ? 'It falls' : 'They fall'} outside the new dates and will be deleted.` +
          (withResults > 0
            ? ` ${withResults} of them ${withResults === 1 ? 'holds' : 'hold'} what the athlete logged.`
            : ''),
        confirmLabel: 'Remove and save',
        destructive: true,
      })
      if (!ok) return
    }
    setSavingDuration(true)
    try {
      await sendJson('PUT', `/api/programs/${id}/duration`, {
        start_date: setupForm.start_date,
        weeks: Number(setupForm.weeks),
        remove_outside: removed.length > 0,
      })
      // The training days may have moved or gone: show what is stored.
      await reloadProgram()
      setDurationOpen(false)
    } catch (err) {
      toast.error(`Could not change the dates. ${errorMessage(err)} Nothing was changed.`)
    } finally {
      setSavingDuration(false)
    }
  }

  const handleDelete = async () => {
    if (!(await confirm({ title: 'Delete this program?', confirmLabel: 'Delete', destructive: true }))) return
    // Used to navigate away whether or not anything had been deleted, so a
    // refused delete looked like a successful one until the list was reopened.
    try {
      await sendJson('DELETE', `/api/programs/${id}`)
    } catch (err) {
      toast.error(`Could not delete this program. ${errorMessage(err)}`)
      return
    }
    navigate('/programs')
  }

  const handleActivateDraft = async () => {
    if (!program || !id) return
    try {
      const updated = await sendJson<Partial<Program>>('PUT', `/api/programs/${id}`, { status: 'active' })
      setProgram((p) => p ? { ...p, ...updated } : p)
    } catch (err) {
      toast.error(`Could not make this program active. ${errorMessage(err)}`)
    }
  }

  const openDetails = () => {
    if (!program) return
    setDetailsForm({ name: program.name, description: program.description ?? '' })
    setDetailsOpen(true)
  }
  const saveDetails = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id || !detailsForm.name.trim()) return
    setSavingDetails(true)
    try {
      const updated = await sendJson<Partial<Program>>('PUT', `/api/programs/${id}`, {
        name: detailsForm.name.trim(),
        description: detailsForm.description.trim(),
      })
      setProgram((p) => (p ? { ...p, name: updated.name ?? p.name, description: updated.description ?? null } : p))
      setDetailsOpen(false)
    } catch (err) {
      toast.error(`Could not save the name and description. ${errorMessage(err)}`)
    } finally {
      setSavingDetails(false)
    }
  }

  // Opens over the calendar. It used to blank the program's dates locally to
  // swap the whole calendar for the setup form.
  const handleChangeDuration = () => {
    if (!program) return
    const current = program.start_date && program.end_date
      ? weeksBetween(program.start_date, program.end_date)
      : 4
    setSetupForm({ start_date: program.start_date ?? '', weeks: String(current) })
    setDurationOpen(true)
  }
  handleChangeDurationRef.current = handleChangeDuration

  const toggleColumn = async (col: ToggleableColumn) => {
    if (!program || !id) return
    const current = program.enabled_columns ?? TOGGLEABLE_COLUMNS
    const nextSet = current.includes(col) ? current.filter((c) => c !== col) : [...current, col]
    const ordered = TOGGLEABLE_COLUMNS.filter((c) => nextSet.includes(c))
    setProgram({ ...program, enabled_columns: ordered })
    try {
      await sendJson('PUT', `/api/programs/${id}`, { enabled_columns: ordered })
    } catch (err) {
      // Shown ticked but not stored: the next export would not match the
      // screen. Put the tick back where the server has it.
      setProgram((p) => (p ? { ...p, enabled_columns: current } : p))
      toast.error(`Could not change the columns. ${errorMessage(err)}`)
    }
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
    try {
      await sendJson('PUT', `/api/programs/${program.id}`, { focus: next })
      setProgram((p) => (p ? { ...p, focus: next } : p))
    } catch (err) {
      toast.error(`Could not change the training focus. ${errorMessage(err)}`)
    }
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
          {/* Name and description used to be fixed once created: renaming was
              only in the Programs list, and the description not at all. */}
          <Button
            variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground"
            onClick={openDetails} aria-label="Edit name and description" title="Edit name and description"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
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
              <Button variant="ghost" size="sm" onClick={() => setColumnsOpen(true)} title="Columns (Ctrl+Shift+C)">
                <SlidersHorizontal className="h-4 w-4" />Columns
              </Button>
              <Button variant="ghost" size="sm" onClick={handleChangeDuration} title="Dates (Ctrl+Shift+D)">
                <CalendarRange className="h-4 w-4" />Dates
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)} title="Import results (Ctrl+I)">
                <Download className="h-4 w-4" />Import
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/programs/${program.id}/report`} title="Report (Ctrl+R)">
                  <BarChart2 className="h-4 w-4" />Report
                </Link>
              </Button>
              <span aria-hidden className="mx-1 h-5 w-px bg-border" />
              <div className="relative" ref={exportMenuRef}>
                <Button
                  size="sm" ref={exportMenu.triggerRef}
                  aria-haspopup="menu" aria-expanded={exportMenuOpen} title="Export (Ctrl+E)"
                  onClick={(e) => { e.stopPropagation(); setExportMenuOpen((v) => !v) }}
                >
                  <Upload className="h-4 w-4" />Export<ChevronDown className="h-4 w-4 -mr-0.5 opacity-70" />
                </Button>
                {exportMenuOpen && (
                  <div
                    ref={exportMenu.menuRef} role="menu" aria-label="Export"
                    className="absolute right-0 top-full mt-1 z-20 min-w-[200px] rounded-lg border bg-popover py-1 shadow-xl shadow-black/20"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button" role="menuitem"
                      onClick={() => { exportMenu.triggerRef.current?.focus(); setExportMenuOpen(false); setPreviewOpen(true) }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                    >
                      <Eye className="h-4 w-4" />Preview Excel
                    </button>
                    <button
                      type="button" role="menuitem"
                      onClick={() => { exportMenu.triggerRef.current?.focus(); setExportMenuOpen(false); handleExport() }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                    >
                      <Download className="h-4 w-4" />Download as Excel
                    </button>
                    <button
                      type="button" role="menuitem"
                      onClick={() => { exportMenu.triggerRef.current?.focus(); setExportMenuOpen(false); setEmailOpen(true) }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent focus:bg-accent focus:outline-none"
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
          <div ref={calendarRef} className="overflow-x-auto rounded-xl border border-border bg-card">
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
                    <th className="num relative border-b border-r border-border p-0 align-top text-[11px] font-medium text-muted-foreground">
                      {/* The week's own actions: copying week 1 across a block
                          used to mean opening every training day in turn. */}
                      <button
                        type="button"
                        ref={weekMenu === row.weekIndex ? weekMenuKeys.triggerRef : undefined}
                        onClick={(e) => { e.stopPropagation(); setWeekMenu(weekMenu === row.weekIndex ? null : row.weekIndex) }}
                        aria-haspopup="menu"
                        aria-expanded={weekMenu === row.weekIndex}
                        aria-label={`Week ${row.weekIndex + 1} actions`}
                        title={`Week ${row.weekIndex + 1}, from ${shortDate(row.days[0].date)}: copy or clear`}
                        className="h-full w-full px-2 py-2 text-left transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary"
                      >
                        W{row.weekIndex + 1}
                        {/* Where in the calendar this week is, without counting. */}
                        <span className="mt-0.5 block text-[9.5px] font-normal leading-tight text-muted-foreground/80">
                          {shortDate(row.days[0].date)}
                        </span>
                      </button>
                      {weekMenu === row.weekIndex && (
                        <div
                          role="menu"
                          ref={weekMenuKeys.menuRef}
                          aria-label={`Week ${row.weekIndex + 1}`}
                          className="absolute left-1 top-8 z-20 min-w-[170px] rounded-lg border bg-popover py-1 text-left text-sm font-normal text-foreground shadow-xl shadow-black/20"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button" role="menuitem"
                            disabled={!weekHasExercises(row.weekIndex) || grid.rows.length < 2}
                            onClick={() => { weekMenuKeys.triggerRef.current?.focus(); setWeekMenu(null); setCopyWeekTo(new Set()); setCopyWeekFrom(row.weekIndex) }}
                            className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50"
                          >
                            <Copy className="h-4 w-4" />Copy week to…
                          </button>
                          <button
                            type="button" role="menuitem"
                            disabled={!weekHasExercises(row.weekIndex)}
                            onClick={() => { weekMenuKeys.triggerRef.current?.focus(); setWeekMenu(null); void days.clearDays(weekDates(row.weekIndex), `Week ${row.weekIndex + 1} cleared`) }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" />Clear week
                          </button>
                        </div>
                      )}
                    </th>
                    {row.days.map((cell) => {
                      const workout = workoutByDate.get(cell.date)
                      const status = cellStatus[cell.date]
                      const exercises = workout?.exercises ?? []
                      const isDragSource = dayDragSource === cell.date
                      const isDragOver = dayDragOver === cell.date
                      const onClipboard = days.clipboard?.date === cell.date ? days.clipboard.mode : null
                      const isToday = cell.date === today
                      // Logged: the athlete has filled in Load Used or RPE. A past
                      // training day without either is flagged, so a missed
                      // import (or a missed session) shows in the grid.
                      const logged = dayHasResults(workout)
                      const notLogged = !logged && exercises.length > 0 && cell.date < today
                      return (
                        <td
                          key={cell.date}
                          draggable={exercises.length > 0}
                          onDragStart={exercises.length > 0 ? (e) => {
                            e.dataTransfer.effectAllowed = 'copyMove'
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
                            void handleDayDrop(cell.date, e.ctrlKey)
                          } : undefined}
                          onDragEnd={() => { setDayDragSource(null); setDayDragOver(null) }}
                          className={`border-r border-b border-border align-top p-0 transition-colors last:border-r-0 ${
                            isDragSource || onClipboard === 'cut' ? 'opacity-40' :
                            isDragOver ? (workout ? 'ring-2 ring-inset ring-warning bg-warning/10' : 'ring-2 ring-inset ring-primary/50 bg-primary/5') :
                            ''
                          }`}
                        >
                          <button
                            type="button"
                            data-day={cell.date}
                            // Arrow keys move between days; Tab stops on one.
                            tabIndex={cell.date === tabStopDay ? 0 : -1}
                            onFocus={() => setCurrentDay(cell.date)}
                            onKeyDown={(e) => onDayKeyDown(e, cell.date)}
                            onClick={() => { hidePreview(); setOpenDate(cell.date) }}
                            onMouseEnter={exercises.length > 0 ? (e) => showPreviewSoon(cell.date, e.currentTarget) : undefined}
                            onMouseLeave={hidePreview}
                            onDragStart={hidePreview}
                            aria-label={`${dayTitle(cell.date)}${isToday ? ', today' : ''}, ${exercises.length === 0 ? 'empty' : `${exercises.length} exercise${exercises.length === 1 ? '' : 's'}`}${logged ? ', logged' : notLogged ? ', not logged yet' : ''}${onClipboard ? `, ${onClipboard === 'cut' ? 'cut' : 'copied'}` : ''}`}
                            className={`group/cell block h-full min-h-[92px] w-full px-2.5 py-2 text-left transition-colors duration-150 ease-smooth hover:bg-primary/[0.06] focus:bg-primary/[0.06] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary ${
                              exercises.length > 0 ? 'shadow-[inset_2px_0_0_hsl(var(--primary)/0.55)]' : ''
                            } ${isToday ? 'bg-primary/[0.04]' : ''} ${onClipboard ? 'outline-dashed outline-2 -outline-offset-2 outline-primary/70' : ''}`}
                          >
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              {isToday ? (
                                <span className="num rounded-full bg-primary px-1.5 font-semibold text-primary-foreground" title="Today">{cell.label}</span>
                              ) : (
                                <span className="num">{cell.label}</span>
                              )}
                              <span className="flex items-center gap-0.5">
                                {logged && (
                                  <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-success" title="The athlete has logged results on this day">
                                    <Check className="h-2.5 w-2.5" />Logged
                                  </span>
                                )}
                                {notLogged && (
                                  <span
                                    aria-hidden
                                    className="h-1.5 w-1.5 rounded-full border border-warning"
                                    title="Past training day with nothing logged yet"
                                  />
                                )}
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
                                    {/* The target, so an RPE- or %-based program reads in the grid. */}
                                    {ex.intensity && (
                                      <span className="text-muted-foreground"> · {ex.intensity}</span>
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

      {preview && !dayDragSource && !openDate && workoutByDate.get(preview.date) && (
        <DayPreview workout={workoutByDate.get(preview.date)!} title={dayTitle(preview.date)} anchor={preview.rect} />
      )}

      <Dialog open={openDate !== null} onOpenChange={(o) => { if (!o) setOpenDate(null) }}>
        {/* Bounded and laid out as a column so a long day scrolls inside the
            dialog. Unbounded, a 25-exercise day measured 1,437 px in a 764 px
            window with the title and "Add exercise" both off-screen. */}
        <DialogContent
          className="flex max-h-[92vh] w-fit max-w-[95vw] flex-col"
          // The editor puts the cursor in the first cell itself; Radix would
          // otherwise pick the first button in the header.
          onOpenAutoFocus={(e) => e.preventDefault()}
          // Back to the day that was open — which, after paging, is not the
          // cell that was clicked to open the dialog.
          onCloseAutoFocus={(e) => {
            const date = lastOpenDate.current
            const cell = date ? calendarRef.current?.querySelector<HTMLElement>(`[data-day="${date}"]`) ?? null : null
            if (cell) { e.preventDefault(); cell.focus() }
          }}
          // With the exercise suggestions open, the first Esc closes that list
          // (the name cell does it) and the day stays open.
          onEscapeKeyDown={(e) => {
            if (document.querySelector('[data-exercise-suggestions]')) e.preventDefault()
          }}
          onKeyDown={(e) => {
            if (e.key !== 'PageDown' && e.key !== 'PageUp') return
            e.preventDefault()
            const step = (e.ctrlKey ? 7 : 1) * (e.key === 'PageDown' ? 1 : -1)
            goToDay(step)
          }}
          // Ctrl+Z reaches the last undoable action while its Undo is on offer.
          // The toast holding that button is outside this dialog, where Tab
          // cannot go.
          onKeyDownCapture={(e) => {
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && days.undoLast()) {
              e.preventDefault()
            }
          }}
        >
          <DialogHeader className="shrink-0 pr-8">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <DialogTitle>{openDate ? dayTitle(openDate) : ''}</DialogTitle>
              <div className="flex items-center gap-0.5">
                <Button
                  type="button" variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => goToDay(-1)} disabled={!canGoToDay(-1)}
                  aria-label="Previous day" title="Previous day (Page Up)"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button" variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => goToDay(1)} disabled={!canGoToDay(1)}
                  aria-label="Next day" title="Next day (Page Down)"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              {/* The same status the calendar cell shows — but that cell is
                  under the overlay while the day is open. */}
              <span className="ml-auto text-xs text-muted-foreground" role="status" aria-live="polite">
                {openDate && cellStatus[openDate] === 'saving' && (
                  <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Saving…</span>
                )}
                {openDate && cellStatus[openDate] === 'error' && (
                  <span className="inline-flex items-center gap-1 text-destructive"><X className="h-3 w-3" />Not saved</span>
                )}
                {openDate && !cellStatus[openDate] && unsavedCount === 0 && (
                  <span className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-success" />Saved</span>
                )}
                {openDate && cellStatus[openDate] === 'saved' && (
                  <span className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-success" />Saved</span>
                )}
              </span>
            </div>
          </DialogHeader>
          {openDate && (
            <ExerciseEditor
              // A fresh editor per day: paging must not carry the copy panel or
              // a drag over from the day before.
              key={openDate}
              workout={openWorkout}
              enabledColumns={enabledColumns}
              programId={id ?? ''}
              copyGrid={copyGrid}
              // Marks the exact cells that did not save, so the banner's count
              // maps to something the coach can actually find on the page.
              unsavedKeys={new Set(Object.keys(failedEdits))}
              onAdd={() => addExercise(openDate)}
              suggestions={ownExerciseNames}
              onDuplicate={(exerciseId) => {
                if (openWorkout) void duplicateExercise(openDate, openWorkout.id, exerciseId)
              }}
              onSaveField={(exerciseId, patch) =>
                openWorkout
                  ? saveExerciseField(openDate, openWorkout.id, exerciseId, patch)
                  : Promise.resolve(false)
              }
              onDeleteExercise={async (exerciseId) => {
                if (!openWorkout) return false
                // Kept as it was, to put back if the coach presses Undo.
                const row = openWorkout.exercises.find((ex) => ex.id === exerciseId)
                const gone = await deleteExercise(openDate, openWorkout.id, exerciseId)
                if (gone && row) {
                  days.offerExerciseUndo(openWorkout.id, [row], `${row.name.trim() || 'Exercise'} deleted`)
                }
                return gone
              }}
              onDeleteWorkout={() => {
                void days.clearDay(openDate).then((cleared) => { if (cleared) setOpenDate(null) })
              }}
              onAddSet={(exerciseId) => {
                if (openWorkout) addSet(openDate, openWorkout.id, exerciseId)
              }}
              onReorder={(exerciseIds) => {
                if (openWorkout) reorderExercises(openDate, openWorkout.id, exerciseIds)
              }}
              // Resolves false when nothing was copied, and the panel then
              // stays open with its ticks, so a retry is one click.
              onCopyDay={(targetDates) =>
                days.copyDays(
                  targetDates.map((target) => ({ source: openDate, target })),
                  `${shortDayLabel(openDate)} copied to ${targetDates.length} day${targetDates.length === 1 ? '' : 's'}`,
                )
              }
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

      <Dialog open={copyWeekFrom !== null} onOpenChange={(o) => { if (!o) setCopyWeekFrom(null) }}>
        {copyWeekFrom !== null && grid && (
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Copy week {copyWeekFrom + 1} to</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Each ticked week becomes a copy of week {copyWeekFrom + 1}, rest days included. What is in it now is replaced.
            </p>
            <div className="space-y-1">
              {grid.rows.filter((r) => r.weekIndex !== copyWeekFrom).map((r) => {
                const results = weekHasResults(r.weekIndex)
                return (
                  <label key={r.weekIndex} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={copyWeekTo.has(r.weekIndex)}
                      onChange={() => setCopyWeekTo((prev) => {
                        const next = new Set(prev)
                        if (next.has(r.weekIndex)) next.delete(r.weekIndex); else next.add(r.weekIndex)
                        return next
                      })}
                    />
                    Week {r.weekIndex + 1}
                    {results
                      ? <span className="text-xs text-warning">has athlete results</span>
                      : weekHasExercises(r.weekIndex) && <span className="text-xs text-muted-foreground">has exercises</span>}
                  </label>
                )
              })}
            </div>
            {[...copyWeekTo].some(weekHasResults) && (
              <p className="text-xs font-medium text-destructive" role="alert">
                A ticked week holds what the athlete logged. Copying over it erases that.
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" disabled={copyWeekTo.size === 0} onClick={() => void runCopyWeek()}>
                Copy to {copyWeekTo.size} week{copyWeekTo.size === 1 ? '' : 's'}
              </Button>
              <Button
                size="sm" variant="outline"
                // Weeks with athlete results stay unticked, as in the day panel.
                onClick={() => setCopyWeekTo(new Set(
                  grid.rows.map((r) => r.weekIndex).filter((w) => w !== copyWeekFrom && !weekHasResults(w)),
                ))}
              >
                All weeks
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCopyWeekFrom(null)}>Cancel</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={detailsOpen} onOpenChange={(o) => { if (!savingDetails) setDetailsOpen(o) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Name and description</DialogTitle>
          </DialogHeader>
          <form onSubmit={saveDetails} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="program_name">Name</Label>
              <Input
                id="program_name" required maxLength={200}
                value={detailsForm.name}
                onChange={(e) => setDetailsForm({ ...detailsForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="program_description">Description</Label>
              <Textarea
                id="program_description" maxLength={2000}
                value={detailsForm.description}
                onChange={(e) => setDetailsForm({ ...detailsForm, description: e.target.value })}
                onKeyDown={(e) => {
                  // Ctrl+Enter saves from inside the text; Enter is a new line.
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit() }
                }}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={savingDetails || !detailsForm.name.trim()}>
                {savingDetails ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDetailsOpen(false)} disabled={savingDetails}>Cancel</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={durationOpen} onOpenChange={(o) => { if (!savingDuration) setDurationOpen(o) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Dates</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSetupSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="duration_start">Start date</Label>
              <Input
                id="duration_start" type="date" required
                value={setupForm.start_date}
                onChange={(e) => setSetupForm({ ...setupForm, start_date: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="duration_weeks">Number of weeks</Label>
              <Input
                id="duration_weeks" type="number" min="1" max="52" required
                value={setupForm.weeks}
                onChange={(e) => setSetupForm({ ...setupForm, weeks: e.target.value })}
              />
            </div>
            {durationPlan && (
              <div className="space-y-1 text-xs" aria-live="polite">
                <p className="text-muted-foreground">
                  <span className="num text-foreground">{durationPlan.newStart} → {durationPlan.newEnd}</span>.{' '}
                  {durationPlan.shiftDays === 0
                    ? 'The training days stay where they are.'
                    : `Every training day moves ${Math.abs(durationPlan.shiftDays)} day${Math.abs(durationPlan.shiftDays) === 1 ? '' : 's'} ${durationPlan.shiftDays > 0 ? 'later' : 'earlier'}.`}
                </p>
                {durationPlan.outside.length > 0 && (
                  <p className="font-medium text-destructive" role="alert">
                    {durationPlan.outside.length} training day{durationPlan.outside.length === 1 ? '' : 's'} would fall
                    outside these dates and be removed.
                  </p>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={savingDuration || !setupForm.start_date}>
                {savingDuration ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDurationOpen(false)} disabled={savingDuration}>
                Cancel
              </Button>
            </div>
          </form>
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
