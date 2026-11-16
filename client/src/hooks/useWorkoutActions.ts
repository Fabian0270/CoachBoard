import { useState } from 'react'
import type { Program, Workout, Exercise } from '../lib/programUtils'
import { pendingWorkoutCreations } from '../lib/programUtils'
import {
  clearFailure,
  clearFailuresForExercise,
  rememberFailure,
  type FailedEditMap,
} from '../lib/failedEdits'
import { errorMessage, sendJson } from '../lib/api'

type SetProgram = React.Dispatch<React.SetStateAction<Program | null>>
type FlashCell = (date: string, status: 'saving' | 'saved' | 'error') => void

/**
 * The program grid used to lose edits silently. A cell holds its typed value in
 * local draft state and commits on blur; when the commit failed, the handler
 * flashed the day cell red for 2.5 seconds and returned without touching program
 * state. The draft still showed what the coach typed, so the cell looked saved —
 * and the edit was gone at the next reload. On the app's core editing surface
 * that is the worst possible failure shape: indistinguishable from success.
 *
 * The registry that fixes it lives in lib/failedEdits.ts, pure and tested,
 * because its correctness IS the safety property.
 */
export function useWorkoutActions(
  id: string | undefined,
  workoutByDate: Map<string, Workout>,
  setProgram: SetProgram,
  flashCell: FlashCell,
  onSaveError?: (message: string) => void,
) {
  const [failedEdits, setFailedEdits] = useState<FailedEditMap>({})

  const updateWorkout = (workoutId: string, mut: (w: Workout) => Workout) => {
    setProgram((p) => p ? { ...p, workouts: p.workouts.map((w) => w.id === workoutId ? mut(w) : w) } : p)
  }

  const ensureWorkout = (date: string): Promise<Workout | null> => {
    if (!id) return Promise.resolve(null)
    const existing = workoutByDate.get(date)
    if (existing) return Promise.resolve(existing)

    // Keyed per program so concurrent edits on the same date in different
    // programs never share an in-flight creation.
    const pendingKey = `${id}:${date}`
    const inFlight = pendingWorkoutCreations.get(pendingKey)
    if (inFlight) return inFlight

    const promise = fetch(`/api/programs/${id}/workouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: date, scheduled_date: date }),
    }).then(async (res) => {
      if (!res.ok) return null
      const w = await res.json()
      const created: Workout = { ...w, exercises: [] }
      setProgram((p) => p ? { ...p, workouts: [...p.workouts, created] } : p)
      return created
    }).catch(() => null).finally(() => {
      pendingWorkoutCreations.delete(pendingKey)
    })

    pendingWorkoutCreations.set(pendingKey, promise)
    return promise
  }

  const addExercise = async (date: string): Promise<void> => {
    if (!id) return
    flashCell(date, 'saving')
    try {
      const workout = await ensureWorkout(date)
      if (!workout) { flashCell(date, 'error'); return }
      const res = await fetch(`/api/programs/${id}/workouts/${workout.id}/exercises`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', order_index: workout.exercises.length }),
      })
      if (!res.ok) { flashCell(date, 'error'); return }
      const ex: Exercise = await res.json()
      updateWorkout(workout.id, (w) => ({ ...w, exercises: [...w.exercises, ex] }))
      flashCell(date, 'saved')
    } catch {
      flashCell(date, 'error')
    }
  }

  /**
   * Commit one cell. Records the edit when it does not land, so nothing is lost
   * without the coach being told and given a way to try again.
   */
  const saveExerciseField = async (date: string, workoutId: string, exerciseId: string, patch: Partial<Exercise>): Promise<boolean> => {
    if (!id) return false
    // Blur sends one column at a time; join defensively so a multi-field patch
    // still gets a stable key rather than silently colliding on the first one.
    const field = Object.keys(patch).join(',')
    flashCell(date, 'saving')

    const remember = (reason: string) => {
      flashCell(date, 'error')
      setFailedEdits((prev) =>
        rememberFailure(prev, { date, workoutId, exerciseId, patch, field }),
      )
      onSaveError?.(reason)
    }

    try {
      const res = await fetch(`/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        remember(`Could not save that change (server said ${res.status}).`)
        return false
      }
      const updated: Exercise = await res.json()
      updateWorkout(workoutId, (w) => ({
        ...w,
        exercises: w.exercises.map((ex) => ex.id === exerciseId ? updated : ex),
      }))
      setFailedEdits((prev) => clearFailure(prev, exerciseId, field))
      flashCell(date, 'saved')
      return true
    } catch {
      remember('Could not save that change — CoachBoard could not reach its own server.')
      return false
    }
  }

  /**
   * Re-send everything that failed.
   *
   * Counts results as they come back rather than re-reading state afterwards,
   * so a partial recovery is reported as partial. Saying "all saved" because the
   * button was pressed would recreate the exact bug this whole mechanism exists
   * to remove.
   */
  const retryFailedEdits = async (): Promise<{ recovered: number; stillFailing: number }> => {
    const pending = Object.values(failedEdits)
    let recovered = 0
    for (const edit of pending) {
      if (await saveExerciseField(edit.date, edit.workoutId, edit.exerciseId, edit.patch)) {
        recovered++
      }
    }
    return { recovered, stillFailing: pending.length - recovered }
  }

  /** Resolves false when the exercise is still there (the delete was refused). */
  const deleteExercise = async (date: string, workoutId: string, exerciseId: string): Promise<boolean> => {
    if (!id) return false
    flashCell(date, 'saving')
    try {
      const res = await fetch(`/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) {
        // Used to flash the day cell red and nothing else — invisible from
        // inside the open day, where the row simply stayed put.
        flashCell(date, 'error')
        onSaveError?.(`Could not delete that exercise (server said ${res.status}). It is still there.`)
        return false
      }
      updateWorkout(workoutId, (w) => ({ ...w, exercises: w.exercises.filter((ex) => ex.id !== exerciseId) }))
      // A deleted exercise cannot have outstanding edits; leaving them would
      // keep the unsaved banner up forever with nothing behind it to retry.
      setFailedEdits((prev) => clearFailuresForExercise(prev, exerciseId))
      flashCell(date, 'saved')
      return true
    } catch {
      flashCell(date, 'error')
      onSaveError?.('Could not delete that exercise — CoachBoard could not reach its own server. It is still there.')
      return false
    }
  }

  const addSet = async (date: string, workoutId: string, exerciseId: string): Promise<void> => {
    if (!id) return
    flashCell(date, 'saving')
    try {
      const res = await fetch(
        `/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}/add-set`,
        { method: 'POST' },
      )
      if (!res.ok) { flashCell(date, 'error'); return }
      const data: { exercises: Exercise[] } = await res.json()
      updateWorkout(workoutId, (w) => ({ ...w, exercises: data.exercises }))
      flashCell(date, 'saved')
    } catch {
      flashCell(date, 'error')
    }
  }

  /**
   * The coach's own note for a day. Saving one on an empty day creates the day.
   * Resolves false when it did not save (and says why).
   */
  const saveDayNote = async (date: string, notes: string): Promise<boolean> => {
    if (!id) return false
    const existing = workoutByDate.get(date)
    if (!existing && notes.trim() === '') return true
    flashCell(date, 'saving')
    try {
      const workout = existing ?? (await ensureWorkout(date))
      if (!workout) throw new Error('The day could not be created.')
      const saved = await sendJson<Workout>('PUT', `/api/programs/${id}/workouts/${workout.id}`, { notes: notes.trim() || null })
      updateWorkout(workout.id, (w) => ({ ...w, notes: saved.notes }))
      flashCell(date, 'saved')
      return true
    } catch (err) {
      flashCell(date, 'error')
      onSaveError?.(`Could not save the note for this day. ${errorMessage(err)}`)
      return false
    }
  }

  /** Copy an exercise (with its set rows) directly under itself. */
  const duplicateExercise = async (date: string, workoutId: string, exerciseId: string): Promise<void> => {
    if (!id) return
    flashCell(date, 'saving')
    try {
      const data = await sendJson<{ exercises: Exercise[] }>(
        'POST',
        `/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}/duplicate`,
      )
      updateWorkout(workoutId, (w) => ({ ...w, exercises: data.exercises }))
      flashCell(date, 'saved')
    } catch (err) {
      flashCell(date, 'error')
      onSaveError?.(`Could not duplicate that exercise. ${errorMessage(err)}`)
    }
  }

  const reorderExercises = async (date: string, workoutId: string, exerciseIds: string[]): Promise<void> => {
    if (!id) return
    flashCell(date, 'saving')
    try {
      const res = await fetch(`/api/programs/${id}/workouts/${workoutId}/exercises/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exerciseIds }),
      })
      if (!res.ok) { flashCell(date, 'error'); return }
      const data: { exercises: Exercise[] } = await res.json()
      updateWorkout(workoutId, (w) => ({ ...w, exercises: data.exercises }))
      flashCell(date, 'saved')
    } catch {
      flashCell(date, 'error')
    }
  }

  return {
    addExercise,
    saveExerciseField,
    deleteExercise,
    addSet,
    duplicateExercise,
    saveDayNote,
    reorderExercises,
    failedEdits,
    retryFailedEdits,
  }
}
