import { useEffect, useRef, useState } from 'react'
import type { Program, Workout, Exercise } from '../lib/programUtils'
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

/** How long Ctrl+Z still reaches the last action. Matches the toast that offers it. */
const UNDO_WINDOW_MS = 8000

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

  // ── Undo ────────────────────────────────────────────────────────────────
  // The last undoable action, reachable with Ctrl+Z for as long as its toast is
  // up. The toast's button is the mouse path; this is the keyboard one, needed
  // because an open day traps Tab inside the dialog and the toast is outside it.
  const lastUndo = useRef<{ run: () => void; until: number } | null>(null)

  useEffect(() => {
    // Typing after the action means Ctrl+Z is now about the typing: let the
    // text field have it. The toast's Undo button still works.
    const disarm = () => { lastUndo.current = null }
    document.addEventListener('input', disarm, true)
    return () => document.removeEventListener('input', disarm, true)
  }, [])

  const offerUndo = (message: string, run: () => Promise<void>) => {
    let used = false
    // Declared before the toast exists; Ctrl+Z takes the toast down with it, so
    // a dead Undo button is never left on screen.
    let dismiss: () => void = () => {}
    const once = () => {
      if (used) return
      used = true
      lastUndo.current = null
      dismiss()
      void run()
    }
    lastUndo.current = { run: once, until: Date.now() + UNDO_WINDOW_MS }
    dismiss = toast.info(message, { action: { label: 'Undo', onClick: once }, duration: UNDO_WINDOW_MS })
  }

  /** Undo the last action if it is still on offer. Returns whether it did. */
  const undoLast = (): boolean => {
    const u = lastUndo.current
    if (!u || Date.now() > u.until) return false
    u.run()
    return true
  }

  const snapshot = (date: string): DaySnapshot => {
    const w = workoutByDate.get(date)
    if (!w) return { date, workout: null }
    return {
      date,
      workout: {
        id: w.id, name: w.name, notes: w.notes, completed_at: w.completed_at, created_at: w.created_at,
        exercises: w.exercises, mediaIds: mediaIdsFor(w.id),
      },
    }
  }

  const refresh = async () => {
    if (!programId) return
    try {
      setProgram(await getJson<Program>(`/api/programs/${encodeURIComponent(programId)}`))
    } catch (err) {
      toast.error(`The change was saved, but the program could not be refreshed. ${errorMessage(err)}`)
    }
    onMediaChanged()
  }

  const restore = async (days: DaySnapshot[]) => {
    if (!programId) return
    try {
      setProgram(await sendJson<Program>('PUT', `/api/programs/${programId}/days/restore`, { days }))
      onMediaChanged()
    } catch (err) {
      toast.error(`Could not undo that. ${errorMessage(err)}`)
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
    offerUndo(done, () => restore(before))
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
      () => restore(before),
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
    offerUndo(done, () => restore(before))
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

  /** Offer to put deleted exercise rows back into their day. */
  const offerExerciseUndo = (workoutId: string, rows: Exercise[], message: string) => {
    offerUndo(message, async () => {
      if (!programId) return
      try {
        const data = await sendJson<{ exercises: Exercise[] }>(
          'POST', `/api/programs/${programId}/workouts/${workoutId}/exercises/restore`, { exercises: rows },
        )
        setProgram((p) => p
          ? { ...p, workouts: p.workouts.map((w) => (w.id === workoutId ? { ...w, exercises: data.exercises } : w)) }
          : p)
      } catch (err) {
        toast.error(`Could not undo that. ${errorMessage(err)}`)
      }
    })
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
    offerExerciseUndo,
    undoLast,
  }
}
