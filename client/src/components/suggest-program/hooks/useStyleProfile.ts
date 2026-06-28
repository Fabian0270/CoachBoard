import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { knowledgeDefaultsForGoal } from 'coachboard-shared/knowledge'
import type { CoachStyleProfile, DetectedPattern, SuggestionGoal } from 'coachboard-shared'
import { clampDays } from '../helpers'

// Once the coach picks a goal, pull their style profile scoped to that focus.
// When it's usable, default the day-count to their usual cadence. A selected
// pattern owns the defaults, so don't let the profile clobber them.
export function useStyleProfile(params: {
  open: boolean
  goal: SuggestionGoal | null
  selectedPattern: DetectedPattern | null
  setTrainingDays: Dispatch<SetStateAction<3 | 4 | 5>>
  setUseStyle: Dispatch<SetStateAction<boolean>>
}) {
  const { open, goal, selectedPattern, setTrainingDays, setUseStyle } = params
  const [styleProfile, setStyleProfile] = useState<CoachStyleProfile | null>(null)

  useEffect(() => {
    if (!open || !goal) return
    let cancelled = false
    setStyleProfile(null)
    fetch(`/api/style-profile?focus=${goal}`)
      .then((r) => r.json())
      .then((data: CoachStyleProfile) => {
        if (cancelled) return
        setStyleProfile(data)
        if (selectedPattern) return
        setUseStyle(data.usable)
        if (data.usable && data.preferredDaysPerWeek) {
          setTrainingDays(clampDays(data.preferredDaysPerWeek))
        } else if (!data.usable) {
          // No learned style yet → fall back to the knowledge base's typical
          // days-per-week for this goal. Silent default; the coach still sees
          // and can change it.
          setTrainingDays(clampDays(knowledgeDefaultsForGoal(goal).daysPerWeek))
        }
      })
      .catch(() => { if (!cancelled) setStyleProfile(null) })
    return () => { cancelled = true }
  }, [open, goal, selectedPattern]) // eslint-disable-line react-hooks/exhaustive-deps

  return { styleProfile, setStyleProfile }
}
