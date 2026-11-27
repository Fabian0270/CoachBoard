import { useEffect, useRef, useState } from 'react'
import type { Program, Workout } from '../lib/programUtils'
import { errorMessage, getJson, sendJson } from '../lib/api'
import { useToast } from '../components/ui/toast'
import { useConfirm } from '../components/ui/confirm-dialog'

// ---------------------------------------------------------------------------
// Whole-day actions in the program calendar — clear, move, copy, cut, paste —
// and the Undo that goes with each.
//
// Every one of these used to be final. Clearing a day asked first and then it
// was gone; dragging a day onto an occupied one swapped the two without a word;
// "Copy to weeks" erased whatever the athlete had logged on the target days.
// Now each takes a snapshot of the days it is about to touch, does its work,
// and offers Undo, which puts those days back exactly (see restoreDays on the
// server). Asking first is kept for the one case where a slip is expensive:
// a day that holds the athlete's results.
// ---------------------------------------------------------------------------

/** A day exactly as stored, for putting back. `workout: null` = the day was empty. */
export interface DaySnapshot {
  date: string
  workout: (Omit<Workout, 'program_id' | 'scheduled_date'> & { mediaIds: string[] }) | null
}

/** Whether the athlete has logged anything on this day. */
export function dayHasResults(workout: Workout | null | undefined): boolean {
  return !!workout && workout.exercises.some(
    (e) => (e.load_used ?? '').trim() !== '' || (e.rpe ?? '').trim() !== '',
  )
}

/** How long the toast offering Undo / Redo stays up. */
const UNDO_TOAST_MS = 8000

/** One step of the program's history: the days a change touched, as they were before it. */
interface HistoryEntry {
  label: string
  dates: string[]
  /**
   * The days as they were before the change — or a function that works that
   * out when the step is undone. A cell edit uses the function: by the time it
   * is undone every later step has been undone too, so "the day now, with this
   * cell's old values" is exact, whereas a snapshot taken when the save landed
   * can miss an edit saved a moment earlier that the page had not drawn yet.
   */
  before: DaySnapshot[] | (() => DaySnapshot[])
}

interface Options {
  programId: string | undefined
  workoutByDate: Map<string, Workout>
  setProgram: React.Dispatch<React.SetStateAction<Program | null>>
  /** Discord videos attached to a workout, so an undo can attach them again. */
  mediaIdsFor: (workoutId: string) => string[]
  /** Called after anything that may have attached or detached videos. */
  onMediaChanged: () => void
  /** "Mon W2" — how a day is named in messages. */
  labelFor: (date: string) => string
}

export function useDayOperations({ programId, workoutByDate, setProgram, mediaIdsFor, onMediaChanged, labelFor }: Options) {
  const toast = useToast()
  const confirm = useConfirm()
  /** The day on the clipboard, and whether pasting moves it or copies it. */
  const [clipboard, setClipboard] = useState<{ date: string; mode: 'copy' | 'cut' } | null>(null)

  // ── History: Ctrl+Z / Ctrl+Y ────────────────────────────────────────────
  // Every change to the program — a saved cell, an added or deleted exercise,
  // a cleared, moved, copied or pasted day, a note, a fill — is recorded as the
  // days it touched, as they were just before. Undo puts those days back and
  // keeps what it replaced, so Redo can put that back in turn. One mechanism
  // (restoreDays on the server) for every kind of change, so an undo cannot
  // drift out of step with what it undoes. Kept for as long as the program is
  // open; the page starts over for each program.
  const history = useRef<HistoryEntry[]>([])
  const redoStack = useRef<HistoryEntry[]>([])
  const busy = useRef(false)
  /** The toast offering Undo or Redo of the latest step; only one at a time. */
  const dismissToast = useRef<() => void>(() => {})

  // Read through refs: an undo runs later, from a toast or a key press, and
  // must see the program as it is then, not as it was when the toast appeared.
  const workoutByDateRef = useRef(workoutByDate)
  workoutByDateRef.current = workoutByDate
  const mediaIdsForRef = useRef(mediaIdsFor)
  mediaIdsForRef.current = mediaIdsFor

  // Text typed into a field and not yet saved belongs to that field's own undo:
  // Ctrl+Z there takes the typing back first. Once it is saved it is a step.
  const typedInto = useRef<EventTarget | null>(null)
  useEffect(() => {
    const onInput = (e: Event) => { typedInto.current = e.target }
    document.addEventListener('input', onInput, true)
    return () => document.removeEventListener('input', onInput, true)
  }, [])

  const snapshot = (date: string): DaySnapshot => {
    const w = workoutByDateRef.current.get(date)
    if (!w) return { date, workout: null }
    return {
      date,
      workout: {
        id: w.id, name: w.name, notes: w.notes, completed_at: w.completed_at, created_at: w.created_at,
        exercises: w.exercises, mediaIds: mediaIdsForRef.current(w.id),
      },
    }
  }
  const snapshotDays = (dates: string[]): DaySnapshot[] => [...new Set(dates)].map(snapshot)

  /**
   * Record a change that has just been made. `before` is the days it touched,
   * snapshotted before it. With `announce`, a toast offers Undo; a newer step
   * takes the older toast down, so its Undo always means the latest change.
   */
  const record = (label: string, before: DaySnapshot[], announce = false) => {
    if (before.length === 0) return
    push({ label, dates: before.map((d) => d.date), before }, announce)
  }

  /** Record a step whose "before" is worked out when it is undone. See HistoryEntry. */
  const recordLazy = (label: string, dates: string[], before: () => DaySnapshot[]) => push({ label, dates, before }, false)

  const push = (entry: HistoryEntry, announce: boolean) => {
    const label = entry.label
    history.current.push(entry)
    redoStack.current = []
    typedInto.current = null
    dismissToast.current()
    dismissToast.current = announce
      ? toast.info(label, { action: { label: 'Undo', onClick: () => void undo() }, duration: UNDO_TOAST_MS })
      : () => {}
  }

  /** Step back. Resolves false when there was nothing to undo or it failed. */
  const undo = async (): Promise<boolean> => {
    if (busy.current) return false
    const entry = history.current.pop()
    if (!entry) return false
    busy.current = true
    try {
      const current = snapshotDays(entry.dates)
      const before = typeof entry.before === 'function' ? entry.before() : entry.before
      if (!(await restore(before))) { history.current.push(entry); return false }
      redoStack.current.push({ ...entry, before: current })
      dismissToast.current()
      dismissToast.current = toast.info(`Undone: ${entry.label}`, {
        action: { label: 'Redo', onClick: () => void redo() }, duration: UNDO_TOAST_MS,
      })
      return true
    } finally {
      busy.current = false
    }
  }

  /** Step forward again after an undo. */
  const redo = async (): Promise<boolean> => {
    if (busy.current) return false
    const entry = redoStack.current.pop()
    if (!entry) return false
    busy.current = true
    try {
      const current = snapshotDays(entry.dates)
      const after = typeof entry.before === 'function' ? entry.before() : entry.before
      if (!(await restore(after, 'redo'))) { redoStack.current.push(entry); return false }
      history.current.push({ ...entry, before: current })
      dismissToast.current()
      dismissToast.current = toast.info(`Redone: ${entry.label}`, {
        action: { label: 'Undo', onClick: () => void undo() }, duration: UNDO_TOAST_MS,
      })
      return true
    } finally {
      busy.current = false
    }
  }

  /**
   * Whether Ctrl+Z at this moment belongs to a text field (typing not yet
   * saved) rather than to the program's history.
   */
  const keyBelongsToField = (): boolean => {
    const a = document.activeElement
    return !!a && a === typedInto.current && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)
  }

  const offerUndo = (message: string, before: DaySnapshot[]) => record(message, before, true)

  const refresh = async () => {
    if (!programId) return
    try {
      setProgram(await getJson<Program>(`/api/programs/${encodeURIComponent(programId)}`))
    } catch (err) {
      toast.error(`The change was saved, but the program could not be refreshed. ${errorMessage(err)}`)
    }
    onMediaChanged()
  }

  const restore = async (days: DaySnapshot[], what: 'undo' | 'redo' = 'undo'): Promise<boolean> => {
    if (!programId) return false
    try {
      setProgram(await sendJson<Program>('PUT', `/api/programs/${programId}/days/restore`, { days }))
      onMediaChanged()
      return true
    } catch (err) {
      toast.error(`Could not ${what} that. ${errorMessage(err)}`)
      return false
    }
  }

  /** Asks before replacing or clearing days that hold the athlete's results. True = go ahead. */
  const confirmLosingResults = async (dates: string[], verb: 'Replace' | 'Clear'): Promise<boolean> => {
    const withResults = dates.filter((d) => dayHasResults(workoutByDate.get(d)))
    if (withResults.length === 0) return true
    const names = withResults.map(labelFor).join(', ')
    return confirm({
      title: `${verb} ${names}?`,
      description:
        `${withResults.length === 1 ? 'That day holds' : 'Those days hold'} what the athlete logged ` +
        `(Load Used and RPE). ${verb === 'Clear' ? 'Clearing' : 'Replacing'} ` +
        `${withResults.length === 1 ? 'it' : 'them'} erases that. You can undo straight afterwards.`,
      confirmLabel: verb,
      destructive: true,
    })
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Remove everything on the given days (one day, or a whole week). */
  const clearDays = async (dates: string[], done: string): Promise<boolean> => {
    const filled = dates.filter((d) => workoutByDate.get(d))
    if (!programId || filled.length === 0) return false
    if (!(await confirmLosingResults(filled, 'Clear'))) return false
    const before = filled.map(snapshot)
    try {
      for (const date of filled) {
        await sendJson('DELETE', `/api/programs/${programId}/workouts/${workoutByDate.get(date)!.id}`)
      }
    } catch (err) {
      await refresh()
      toast.error(`Could not finish clearing. ${errorMessage(err)}`, {
        action: { label: 'Undo', onClick: () => void restore(before) },
      })
      return false
    }
    const gone = new Set(filled.map((d) => workoutByDate.get(d)!.id))
    setProgram((p) => (p ? { ...p, workouts: p.workouts.filter((x) => !gone.has(x.id)) } : p))
    onMediaChanged()
    setClipboard((c) => (c && filled.includes(c.date) ? null : c))
    offerUndo(done, before)
    return true
  }

  /** Remove everything on a day. */
  const clearDay = (date: string): Promise<boolean> => clearDays([date], `${labelFor(date)} cleared`)

  /**
   * Move a day. An occupied target swaps places with it (dragging), or is
   * replaced by it (`replace`: cut and paste).
   */
  const moveDay = async (source: string, target: string, replace = false): Promise<boolean> => {
    if (!programId || source === target || !workoutByDate.get(source)) return false
    const occupied = !!workoutByDate.get(target)
    if (replace && occupied && !(await confirmLosingResults([target], 'Replace'))) return false
    const before = [snapshot(source), snapshot(target)]
    try {
      await sendJson('POST', `/api/programs/${programId}/move-day`, { sourceDate: source, targetDate: target, replace })
    } catch (err) {
      toast.error(`Could not move ${labelFor(source)}. ${errorMessage(err)} Nothing was changed.`)
      return false
    }
    await refresh()
    offerUndo(
      occupied && !replace
        ? `Swapped ${labelFor(source)} and ${labelFor(target)}`
        : `Moved ${labelFor(source)} to ${labelFor(target)}`,
      before,
    )
    return true
  }

  /**
   * Make each target a copy of its source — replacing what is there, and
   * emptying the target when the source is empty (copying a week copies its
   * rest days too). The caller decides which targets are allowed; days with
   * athlete results are only ever in the list on purpose.
   */
  const copyDays = async (pairs: { source: string; target: string }[], done: string): Promise<boolean> => {
    if (!programId) return false
    const work = pairs.filter((p) => p.source !== p.target)
    if (work.length === 0) return false
    const before = work.map((p) => snapshot(p.target))
    try {
      const bySource = new Map<string, string[]>()
      for (const p of work) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p.target])
      for (const [source, targets] of bySource) {
        const src = workoutByDate.get(source)
        if (src && src.exercises.length > 0) {
          await sendJson('POST', `/api/programs/${programId}/copy-day`, { sourceDate: source, targetDates: targets })
        } else {
          for (const target of targets) {
            const w = workoutByDate.get(target)
            if (w) await sendJson('DELETE', `/api/programs/${programId}/workouts/${w.id}`)
          }
        }
      }
    } catch (err) {
      // Some targets may already have been written; show what is stored and
      // leave the way back open.
      await refresh()
      toast.error(`The copy did not finish. ${errorMessage(err)}`, {
        action: { label: 'Undo', onClick: () => void restore(before) },
      })
      return false
    }
    await refresh()
    offerUndo(done, before)
    return true
  }

  /**
   * Run a change that touches the given days, then offer Undo, which puts those
   * days back as they were. For changes made on the server in one call (such
   * as replacing an exercise across the block).
   */
  const withUndo = async (dates: string[], run: () => Promise<void>, done: string): Promise<boolean> => {
    if (!programId || dates.length === 0) return false
    const before = dates.map(snapshot)
    try {
      await run()
    } catch (err) {
      toast.error(`That did not work. ${errorMessage(err)} Nothing was changed.`)
      return false
    }
    await refresh()
    offerUndo(done, before)
    return true
  }

  const copyToClipboard = (date: string) => {
    if (workoutByDate.get(date)?.exercises.length) setClipboard({ date, mode: 'copy' })
  }
  const cutToClipboard = (date: string) => {
    if (workoutByDate.get(date)?.exercises.length) setClipboard({ date, mode: 'cut' })
  }

  /** Paste the clipboard day onto `date`, replacing what is there. */
  const paste = async (date: string): Promise<boolean> => {
    const clip = clipboard
    if (!clip || clip.date === date) return false
    if (!workoutByDate.get(clip.date)) { setClipboard(null); return false }
    if (clip.mode === 'cut') {
      const moved = await moveDay(clip.date, date, true)
      if (moved) setClipboard(null)
      return moved
    }
    if (!(await confirmLosingResults([date], 'Replace'))) return false
    return copyDays([{ source: clip.date, target: date }], `${labelFor(clip.date)} pasted onto ${labelFor(date)}`)
  }


  return {
    clipboard,
    clearClipboard: () => setClipboard(null),
    copyToClipboard,
    cutToClipboard,
    paste,
    clearDay,
    clearDays,
    moveDay,
    copyDays,
    confirmLosingResults,
    withUndo,
    snapshotDays,
    record,
    recordLazy,
    undo,
    redo,
    keyBelongsToField,
  }
}
