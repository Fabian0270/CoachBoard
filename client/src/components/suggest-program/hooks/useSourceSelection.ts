import { useEffect, useState } from 'react'
import type { SelectableAthlete, SelectableProgram, Step } from '../types'

// Owns the athlete + program lists used by the target-athlete step and the
// "base on a source program" step (including the cross-athlete source picker),
// with their shared loading/error state.
export function useSourceSelection(params: {
  open: boolean
  step: Step
  pickingSourceAthlete: boolean
  athleteId?: string
  pickedAthleteId: string | null
  sourceAthleteId: string | null
}) {
  const { open, step, pickingSourceAthlete, athleteId, pickedAthleteId, sourceAthleteId } = params
  const [sourceAthletes, setSourceAthletes] = useState<SelectableAthlete[] | null>(null)
  const [sourcePrograms, setSourcePrograms] = useState<SelectableProgram[] | null>(null)
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | null>(null)

  // Load the athlete list both for the target-athlete step and for the
  // "pick another athlete's program" source picker.
  useEffect(() => {
    if (!open || (step !== 'athlete' && !pickingSourceAthlete) || sourceAthletes !== null) return
    setSourcesLoading(true)
    setSourcesError(null)
    fetch('/api/athletes')
      .then((r) => r.json())
      .then((data) => setSourceAthletes(Array.isArray(data) ? data : []))
      .catch(() => setSourcesError('Failed to load athletes'))
      .finally(() => setSourcesLoading(false))
  }, [open, step, pickingSourceAthlete, sourceAthletes])

  useEffect(() => {
    const targetAthleteId = athleteId ?? pickedAthleteId
    const eid = sourceAthleteId ?? targetAthleteId
    if (!open || step !== 'source' || pickingSourceAthlete || sourcePrograms !== null || !eid) return
    setSourcesLoading(true)
    setSourcesError(null)
    fetch(`/api/programs?athlete_id=${eid}`)
      .then((r) => r.json())
      .then((data) => {
        const all = Array.isArray(data) ? (data as SelectableProgram[]) : []
        setSourcePrograms(all.filter((p) => p.status === 'completed' || p.status === 'archived'))
      })
      .catch(() => setSourcesError('Failed to load programs'))
      .finally(() => setSourcesLoading(false))
  }, [open, step, sourcePrograms, athleteId, pickedAthleteId, sourceAthleteId, pickingSourceAthlete])

  return {
    sourceAthletes, setSourceAthletes,
    sourcePrograms, setSourcePrograms,
    sourcesLoading, setSourcesLoading,
    sourcesError, setSourcesError,
  }
}
