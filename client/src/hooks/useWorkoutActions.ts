import type { Program, Workout, Exercise } from '../lib/programUtils'
import { pendingWorkoutCreations } from '../lib/programUtils'
import { useConfirm } from '../components/ui/confirm-dialog'

type SetProgram = React.Dispatch<React.SetStateAction<Program | null>>
type FlashCell = (date: string, status: 'saving' | 'saved' | 'error') => void

export function useWorkoutActions(
  id: string | undefined,
  workoutByDate: Map<string, Workout>,
  setProgram: SetProgram,
  flashCell: FlashCell,
) {
  const confirm = useConfirm()

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

  const saveExerciseField = async (date: string, workoutId: string, exerciseId: string, patch: Partial<Exercise>): Promise<void> => {
    if (!id) return
    flashCell(date, 'saving')
    try {
      const res = await fetch(`/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) { flashCell(date, 'error'); return }
      const updated: Exercise = await res.json()
      updateWorkout(workoutId, (w) => ({
        ...w,
        exercises: w.exercises.map((ex) => ex.id === exerciseId ? updated : ex),
      }))
      flashCell(date, 'saved')
    } catch {
      flashCell(date, 'error')
    }
  }

  const deleteExercise = async (date: string, workoutId: string, exerciseId: string): Promise<void> => {
    if (!id) return
    flashCell(date, 'saving')
    try {
      const res = await fetch(`/api/programs/${id}/workouts/${workoutId}/exercises/${exerciseId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) { flashCell(date, 'error'); return }
      updateWorkout(workoutId, (w) => ({ ...w, exercises: w.exercises.filter((ex) => ex.id !== exerciseId) }))
      flashCell(date, 'saved')
    } catch {
      flashCell(date, 'error')
    }
  }

  const deleteWorkout = async (workoutId: string, onDeleted: () => void): Promise<void> => {
    if (!id) return
    if (!(await confirm({ title: 'Clear this day?', description: 'All exercises will be removed.', confirmLabel: 'Clear', destructive: true }))) return
    try {
      const res = await fetch(`/api/programs/${id}/workouts/${workoutId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) return
      setProgram((p) => p ? { ...p, workouts: p.workouts.filter((w) => w.id !== workoutId) } : p)
      onDeleted()
    } catch { /* leave state unchanged on network failure */ }
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

  return { addExercise, saveExerciseField, deleteExercise, deleteWorkout, addSet, reorderExercises }
}
