import { defaultVelocityMetric, isVbtLift, type VbtLift } from 'coachboard-shared/vbt'
import { localDay, readSessions, sessionMvt, setSpeed } from 'coachboard-shared/vbtSession'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import type { LiftE1RMTrend } from 'coachboard-shared'

// ---------------------------------------------------------------------------
// The program report's Bar speed section (L2, D68, D69).
//
// The athlete's saved sets linked to this program's days, per week and
// competition lift: the load, the fastest counted rep, and that day's estimated
// max from bar speed (read the way the Progress tab reads sessions, BP33) —
// beside the week's e1RM from Load Used × reps × RPE. The two are never mixed:
// the report's own e1RM stays the logged one (D69).
// ---------------------------------------------------------------------------

export type CompetitionLift = 'squat' | 'bench' | 'deadlift'

/** The competition lift a tracked lift counts as; null for everything else. */
export function competitionLiftOf(lift: string | null): CompetitionLift | null {
  if (lift === 'back-squat') return 'squat'
  if (lift === 'bench-press') return 'bench'
  if (lift === 'deadlift-conventional' || lift === 'deadlift-sumo') return 'deadlift'
  return null
}

export interface BarSpeedSet {
  analysisId: string
  liftKey: CompetitionLift
  lift: VbtLift
  /** The training day's date. */
  date: string | null
  weekIndex: number
  workoutName: string
  exerciseName: string | null
  loadKg: number | null
  /** m/s, in the lift's standard measure. */
  speed: number | null
  metric: string
  /** That day's estimated max from bar speed; null when the day cannot be read. */
  dayMax: number | null
  /** The week's best e1RM from logged sets for this lift; null when none. */
  rpeE1rm: number | null
}

const mondayMs = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.getTime()
}

/** Week 0 starts on the Monday of the program's start (or its first day), as the report's own weeks do. */
export function weekIndexOf(date: string | null, start: string | null): number | null {
  if (!date || !start) return null
  return Math.round((mondayMs(date) - mondayMs(start)) / (7 * 86_400_000))
}

export function barSpeedSets(
  program: { id: string; start_date: string | null; workouts: { id: string; scheduled_date: string | null }[] },
  analyses: VideoAnalysisDto[],
  mvtByLift: Record<string, number>,
  trends: LiftE1RMTrend[],
): BarSpeedSet[] {
  const start = program.start_date ?? program.workouts.map((w) => w.scheduled_date).filter((d): d is string => !!d).sort()[0] ?? null
  const sessions = new Map<string, Map<string, number | null>>()
  const dayMax = (lift: VbtLift, day: string) => {
    if (!sessions.has(lift)) {
      sessions.set(lift, new Map(readSessions(analyses, lift, sessionMvt(lift, mvtByLift[lift])).map((s) => [s.day, s.todayMax])))
    }
    return sessions.get(lift)!.get(day) ?? null
  }
  const out: BarSpeedSet[] = []
  for (const a of analyses) {
    if (a.link?.programId !== program.id) continue
    const liftKey = competitionLiftOf(a.lift)
    if (!liftKey || !isVbtLift(a.lift)) continue
    const weekIndex = weekIndexOf(a.link.date, start)
    if (weekIndex == null || weekIndex < 0) continue
    const trend = trends.find((t) => t.liftKey === liftKey)
    out.push({
      analysisId: a.id,
      liftKey,
      lift: a.lift,
      date: a.link.date,
      weekIndex,
      workoutName: a.link.workoutName,
      exerciseName: a.link.exerciseName,
      loadKg: a.loadKg,
      speed: setSpeed(a.metrics ?? [], a.lift),
      metric: defaultVelocityMetric(a.lift),
      dayMax: dayMax(a.lift, localDay(a.liftedAt)),
      rpeE1rm: trend?.dataPoints.find((p) => p.weekIndex === weekIndex)?.e1rm ?? null,
    })
  }
  const order: CompetitionLift[] = ['squat', 'bench', 'deadlift']
  return out.sort((x, y) =>
    x.weekIndex - y.weekIndex
    || order.indexOf(x.liftKey) - order.indexOf(y.liftKey)
    || (x.date ?? '').localeCompare(y.date ?? '')
    || (x.loadKg ?? 0) - (y.loadKg ?? 0))
}
