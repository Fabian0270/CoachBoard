import { useEffect, useMemo, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { errorMessage, getList } from '../../lib/api'
import type { AnalysisLinkDay } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// Which training day, and which row of it, a set was (L2, D67).
//
// The athlete's days within a week of when the set was lifted. Until the coach
// touches the pickers the link follows the clip: the day a Discord clip is
// attached to, and the row when exactly one fits the lift and load — so typing
// the load can settle the row. Once touched, the coach's choice stands.
// ---------------------------------------------------------------------------

export interface DayLink {
  workoutId: string | null
  exerciseId: string | null
}

export const NO_LINK: DayLink = { workoutId: null, exerciseId: null }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Tue 17 Nov" */
export function shortDay(iso: string | null): string {
  if (!iso) return 'No date'
  const d = new Date(`${iso}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

const rowLabel = (r: AnalysisLinkDay['rows'][number]) => {
  const plan = [r.sets && r.reps ? `${r.sets}×${r.reps}` : r.reps ?? '', r.weight != null ? `@${r.weight}` : ''].filter(Boolean).join(' ')
  return `${r.name}${plan ? ` — ${plan}` : ''}${r.loadUsed ? ` (did ${r.loadUsed})` : ''}`
}

export default function TrainingDayLink({
  athleteId,
  day,
  lift,
  loadKg,
  preferredWorkoutId,
  choice,
  onChoose,
  onResolved,
}: {
  athleteId: string | null
  /** The day the set was lifted, YYYY-MM-DD. */
  day: string
  lift: string | null
  loadKg: number | null
  /** The day the clip is attached to, picked until the coach chooses. */
  preferredWorkoutId: string | null
  /** The coach's choice; null follows the clip. */
  choice: DayLink | null
  onChoose: (link: DayLink) => void
  /** The link as it stands, whoever chose it. */
  onResolved: (link: DayLink) => void
}) {
  const [days, setDays] = useState<AnalysisLinkDay[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!athleteId) { setDays([]); return }
    let cancelled = false
    const q = new URLSearchParams({ athleteId, day })
    if (lift) q.set('lift', lift)
    if (loadKg != null) q.set('loadKg', String(loadKg))
    getList<AnalysisLinkDay>(`/api/analysis/link-candidates?${q}`)
      .then((d) => { if (!cancelled) { setDays(d); setError(null) } })
      .catch((e) => { if (!cancelled) { setDays([]); setError(errorMessage(e)) } })
    return () => { cancelled = true }
  }, [athleteId, day, lift, loadKg])

  const auto = useMemo<DayLink>(() => {
    const preferred = days?.find((d) => d.workoutId === preferredWorkoutId)
    return preferred ? { workoutId: preferred.workoutId, exerciseId: preferred.suggestedExerciseId } : NO_LINK
  }, [days, preferredWorkoutId])
  const link = choice ?? auto

  useEffect(() => { onResolved(link) }, [link.workoutId, link.exerciseId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!athleteId) return null
  const chosenDay = days?.find((d) => d.workoutId === link.workoutId) ?? null

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <CalendarDays className="h-4 w-4 text-muted-foreground" />
      <span className="text-muted-foreground">Training day</span>
      {days === null ? (
        <span className="text-xs text-muted-foreground">Loading…</span>
      ) : days.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {error ? `Could not load the training days. ${error}` : 'No training day within a week of this set.'}
        </span>
      ) : (
        <>
          <select
            aria-label="Training day"
            value={link.workoutId ?? ''}
            onChange={(e) => {
              const picked = days.find((d) => d.workoutId === e.target.value)
              onChoose(picked ? { workoutId: picked.workoutId, exerciseId: picked.suggestedExerciseId } : NO_LINK)
            }}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          >
            <option value="">Not linked</option>
            {days.map((d) => (
              <option key={d.workoutId} value={d.workoutId}>
                {shortDay(d.date)} · {d.workoutName} · {d.programName}
              </option>
            ))}
          </select>
          {chosenDay && (
            <select
              aria-label="Exercise"
              value={link.exerciseId ?? ''}
              onChange={(e) => onChoose({ workoutId: chosenDay.workoutId, exerciseId: e.target.value || null })}
              className="max-w-[18rem] rounded-md border bg-background px-2 py-1 text-sm"
            >
              <option value="">The day only</option>
              {chosenDay.rows.map((r) => (
                <option key={r.exerciseId} value={r.exerciseId}>
                  {r.fits ? '✓ ' : ''}{rowLabel(r)}
                </option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  )
}
