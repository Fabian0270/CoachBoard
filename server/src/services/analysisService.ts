import { getDb } from '../db.js'
import { findProgramForExport } from './programService.js'
import { estimate1RM } from 'coachboard-shared/rpe'
import type {
  E1RMDataPoint,
  LiftE1RMTrend,
  RPEDeviationRow,
  ProgramReport,
  AthleteMax,
} from 'coachboard-shared'

const MAIN_LIFT_KEYWORDS = ['squat', 'bench', 'deadlift'] as const

function mondayOf(date: Date): Date {
  const d = new Date(date)
  const offset = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + offset)
  return d
}

// Parse prescribed RPE from free-text intensity field.
// Accepts: "RPE 8", "@ 8", "@8", "rpe8.5", "@ 8.5" etc.
function parseRpeFromIntensity(intensity: string | null): number | null {
  if (!intensity) return null
  const match = intensity.match(/(?:rpe\s*|@\s*)(\d+(?:[.,]\d+)?)/i)
  if (!match) return null
  const val = parseFloat(match[1].replace(',', '.'))
  if (isNaN(val) || val < 5 || val > 10) return null
  if (!Number.isInteger(val * 2)) return null
  return val
}

export async function getProgramReport(programId: string): Promise<ProgramReport | null> {
  const data = await findProgramForExport(programId)
  if (!data) return null
  const { program, workouts, exercises } = data

  // Map workout id → { weekIndex, dayOfWeek } from scheduled_date + program start
  const workoutWeekMap = new Map<string, { weekIndex: number; dayOfWeek: number }>()

  let startMonday: Date | null = null
  if (program.start_date) {
    const [sy, sm, sd] = program.start_date.split('-').map(Number)
    startMonday = mondayOf(new Date(Date.UTC(sy, sm - 1, sd)))
  } else {
    const sorted = workouts
      .filter((w) => w.scheduled_date)
      .map((w) => w.scheduled_date!)
      .sort()
    if (sorted.length > 0) {
      const [wy, wm, wd] = sorted[0].split('-').map(Number)
      startMonday = mondayOf(new Date(Date.UTC(wy, wm - 1, wd)))
    }
  }

  for (const w of workouts) {
    if (!w.scheduled_date || !startMonday) continue
    const [wy, wm, wd] = w.scheduled_date.split('-').map(Number)
    const d = new Date(Date.UTC(wy, wm - 1, wd))
    const diffDays = Math.round((d.getTime() - startMonday.getTime()) / 86400000)
    workoutWeekMap.set(w.id, {
      weekIndex: Math.max(0, Math.floor(diffDays / 7)),
      dayOfWeek: ((diffDays % 7) + 7) % 7,
    })
  }

  // Completion stats
  const exercisesTotal = exercises.length
  const exercisesCompleted = exercises.filter(
    (ex) => ex.load_used !== null && ex.load_used !== '',
  ).length
  const completionRate = exercisesTotal > 0 ? exercisesCompleted / exercisesTotal : 0

  // e1RM trends — per main lift keyword, best e1RM per week
  const trendsByKeyword = new Map<
    string,
    { displayName: string; pointsMap: Map<number, E1RMDataPoint> }
  >()

  for (const ex of exercises) {
    if (!ex.load_used || !ex.rpe || !ex.reps) continue

    const liftLower = ex.name.toLowerCase()
    const keyword = MAIN_LIFT_KEYWORDS.find((k) => liftLower.includes(k))
    if (!keyword) continue

    const repsMatch = ex.reps.match(/\d+/)
    if (!repsMatch) continue

    const weight = parseFloat(ex.load_used.replace(',', '.'))
    const rpe = parseFloat(ex.rpe.replace(',', '.'))
    const reps = parseInt(repsMatch[0], 10)
    if (isNaN(weight) || isNaN(rpe) || isNaN(reps)) continue

    const e1rmVal = estimate1RM(weight, reps, rpe)
    if (e1rmVal === null) continue

    const loc = workoutWeekMap.get(ex.workout_id)
    const weekIndex = loc?.weekIndex ?? 0
    const rounded = Math.round(e1rmVal * 10) / 10
    const point: E1RMDataPoint = { weekIndex, e1rm: rounded, weight, reps, rpe, exerciseName: ex.name }

    if (!trendsByKeyword.has(keyword)) {
      trendsByKeyword.set(keyword, { displayName: ex.name, pointsMap: new Map() })
    }
    const entry = trendsByKeyword.get(keyword)!
    const existing = entry.pointsMap.get(weekIndex)
    if (!existing || rounded > existing.e1rm) {
      entry.pointsMap.set(weekIndex, point)
    }
  }

  const e1rmTrends: LiftE1RMTrend[] = []
  for (const [liftKey, { displayName, pointsMap }] of trendsByKeyword) {
    const dataPoints = [...pointsMap.values()].sort((a, b) => a.weekIndex - b.weekIndex)
    const e1rms = dataPoints.map((d) => d.e1rm)
    e1rmTrends.push({
      liftKey,
      displayName,
      dataPoints,
      latestE1RM: dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].e1rm : null,
      bestE1RM: e1rms.length > 0 ? Math.max(...e1rms) : null,
    })
  }

  // RPE deviations — exercises with reported RPE; prescribed parsed from intensity field
  const rpeDeviations: RPEDeviationRow[] = []
  for (const ex of exercises) {
    if (!ex.rpe) continue
    const reportedRpe = parseFloat(ex.rpe.replace(',', '.'))
    if (isNaN(reportedRpe)) continue
    const prescribedRpe = parseRpeFromIntensity(ex.intensity)
    const delta =
      prescribedRpe !== null
        ? Math.round((reportedRpe - prescribedRpe) * 10) / 10
        : null
    const loc = workoutWeekMap.get(ex.workout_id)
    rpeDeviations.push({
      exerciseName: ex.name,
      weekIndex: loc?.weekIndex ?? 0,
      dayOfWeek: loc?.dayOfWeek ?? 0,
      prescribedRpe,
      reportedRpe,
      delta,
    })
  }

  const deltas = rpeDeviations.filter((r) => r.delta !== null).map((r) => r.delta!)
  const avgRpeDeviation =
    deltas.length > 0
      ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 100) / 100
      : null

  // Latest stored max per lift for the athlete
  const maxRows = await getDb()
    .selectFrom('athlete_maxes')
    .selectAll()
    .where('athlete_id', '=', program.athlete_id)
    .orderBy('lift_name', 'asc')
    .orderBy('recorded_at', 'desc')
    .execute()

  const seenLifts = new Set<string>()
  const storedMaxes: AthleteMax[] = maxRows.filter((m) => {
    const key = m.lift_name.toLowerCase()
    if (seenLifts.has(key)) return false
    seenLifts.add(key)
    return true
  })

  return {
    programId,
    athleteId: program.athlete_id,
    e1rmTrends,
    rpeDeviations,
    avgRpeDeviation,
    completionRate,
    exercisesTotal,
    exercisesCompleted,
    storedMaxes,
  }
}
