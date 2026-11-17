import { getDb } from '../db.js'
import { estimate1RM } from 'coachboard-shared/rpe'
import { competitionLiftKey } from 'coachboard-shared/vbt'
import type { AthleteProgress, ProgressE1RMPoint, ProgressPR } from 'coachboard-shared'

// ---------------------------------------------------------------------------
// An athlete's progress across every block (I1): the e1RM of each competition
// lift week by week, and the timeline of recorded PRs.
//
// The e1RM is worked out the way the program report does it — from logged
// sets (Load Used × reps at the RPE the athlete reported), competition lifts
// only (D47) — but across all of the athlete's programs and placed by date,
// the best set of each week. The program report shows one block; this shows
// how the blocks join up.
// ---------------------------------------------------------------------------

const mondayOf = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

const LIFT_NAMES = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift' } as const

export async function getAthleteProgress(athleteId: string): Promise<AthleteProgress | null> {
  const db = getDb()
  const athlete = await db.selectFrom('athletes').select('id').where('id', '=', athleteId).executeTakeFirst()
  if (!athlete) return null

  const sets = await db.selectFrom('exercises')
    .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
    .innerJoin('programs', 'programs.id', 'workouts.program_id')
    .select([
      'exercises.name', 'exercises.reps', 'exercises.reps_done', 'exercises.load_used', 'exercises.rpe',
      'workouts.scheduled_date as date', 'programs.id as programId', 'programs.name as programName',
    ])
    .where('programs.athlete_id', '=', athleteId)
    .where('exercises.load_used', 'is not', null)
    .where('exercises.rpe', 'is not', null)
    .execute()

  // Best e1RM per lift per week.
  const best = new Map<string, Map<string, ProgressE1RMPoint>>()
  for (const s of sets) {
    const lift = competitionLiftKey(s.name)
    if (!lift || !s.date) continue
    // The reps actually done when a caption said so (L1, D66), else the plan.
    const reps = parseInt((s.reps_done ?? s.reps ?? '').match(/\d+/)?.[0] ?? '', 10)
    const weight = parseFloat((s.load_used ?? '').replace(',', '.'))
    const rpe = parseFloat((s.rpe ?? '').replace(',', '.'))
    if (!(reps > 0) || !(weight > 0) || isNaN(rpe)) continue
    const e1rm = estimate1RM(weight, reps, rpe)
    if (e1rm === null) continue
    const week = mondayOf(s.date)
    const point: ProgressE1RMPoint = {
      week, date: s.date, e1rm: Math.round(e1rm * 10) / 10, weight, reps, rpe,
      exerciseName: s.name, programId: s.programId, programName: s.programName,
    }
    const byWeek = best.get(lift) ?? new Map<string, ProgressE1RMPoint>()
    best.set(lift, byWeek)
    const had = byWeek.get(week)
    if (!had || point.e1rm > had.e1rm) byWeek.set(week, point)
  }
  const e1rm = (['squat', 'bench', 'deadlift'] as const)
    .filter((l) => best.has(l))
    .map((l) => ({
      liftKey: l,
      displayName: LIFT_NAMES[l],
      points: [...best.get(l)!.values()].sort((a, b) => a.week.localeCompare(b.week)),
    }))

  // PRs: each recorded max that beat every earlier one for the same lift.
  // The competition lifts are matched as one lift whatever they were typed as
  // ("Squat", "Back Squat"); anything else by its own name.
  // Lifted maxes only: an estimate from bar speed is not a PR (D60).
  const maxes = await db.selectFrom('athlete_maxes').selectAll()
    .where('athlete_id', '=', athleteId)
    .where('estimated', '=', 0)
    .orderBy('recorded_at').orderBy('weight')
    .execute()
  const top = new Map<string, number>()
  const prs: ProgressPR[] = []
  for (const m of maxes) {
    const key = competitionLiftKey(m.lift_name) ?? m.lift_name.trim().toLowerCase()
    const before = top.get(key) ?? null
    if (before !== null && m.weight <= before) continue
    top.set(key, m.weight)
    prs.push({ liftName: m.lift_name, weight: m.weight, unit: m.unit, date: m.recorded_at, previous: before })
  }
  prs.reverse() // newest first

  return { e1rm, prs }
}
