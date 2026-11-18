import { getDb } from '../db.js'
import { isVbtLift, matchesLiftName } from 'coachboard-shared/vbt'
import type { AnalysisLinkDay, AnalysisLinkRow } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// Linking a saved bar path analysis to the training day and row it was (L2).
//
// D67: a Discord clip attached to a day takes that day, and the row is picked
// for the coach when exactly one row fits the lift and load; otherwise the save
// form offers the days and rows near when the set was lifted. Nothing here
// links silently except the one-time upgrade below (D70), which only takes
// links that are just as clear.
// ---------------------------------------------------------------------------

/** How far from the lifted day the pickers look. */
const NEAR_DAYS = 7

/** Within 7.5 %, the tolerance the caption matcher uses. */
const agrees = (planned: number | null, kg: number) => planned != null && planned > 0 && Math.abs(planned - kg) / planned <= 0.075

const loadOf = (s: string | null) => {
  const n = Number((s ?? '').replace(',', '.').replace(/[^\d.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The rows a set fits: the lift by name (the VBT lift's own name rules), then
 * narrowed to the load when one agrees with the planned load or the logged one.
 * An unknown lift ('other', or none) fits nothing — guessing from the load alone
 * would pin a squat on the bench row that happened to be planned at 100 kg.
 */
export function rowsFittingSet<T extends { name: string; weight: number | null; load_used: string | null }>(
  rows: T[], lift: string | null, loadKg: number | null,
): T[] {
  if (!isVbtLift(lift) || lift === 'other') return []
  const byLift = rows.filter((r) => matchesLiftName(lift, r.name))
  if (loadKg == null) return byLift
  const byLoad = byLift.filter((r) => agrees(r.weight, loadKg) || agrees(loadOf(r.load_used), loadKg))
  return byLoad.length > 0 ? byLoad : byLift
}

/** The row to pick for the coach: only when exactly one fits. */
export function soleFit<T extends { name: string; weight: number | null; load_used: string | null }>(
  rows: T[], lift: string | null, loadKg: number | null,
): T | null {
  const fits = rowsFittingSet(rows, lift, loadKg)
  return fits.length === 1 ? fits[0] : null
}

const shiftDay = (day: string, by: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return d.toISOString().slice(0, 10)
}

/**
 * The athlete's training days within a week of `day`, closest first, each with
 * its rows marked by whether the set fits them.
 */
export async function linkCandidates(
  athleteId: string, day: string, lift: string | null, loadKg: number | null,
): Promise<AnalysisLinkDay[]> {
  const db = getDb()
  const workouts = await db.selectFrom('workouts')
    .innerJoin('programs', 'programs.id', 'workouts.program_id')
    .select([
      'workouts.id as id', 'workouts.name as name', 'workouts.scheduled_date as date',
      'programs.id as programId', 'programs.name as programName',
    ])
    .where('programs.athlete_id', '=', athleteId)
    .where('workouts.scheduled_date', '>=', shiftDay(day, -NEAR_DAYS))
    .where('workouts.scheduled_date', '<=', shiftDay(day, NEAR_DAYS))
    .execute()
  if (workouts.length === 0) return []
  const exercises = await db.selectFrom('exercises').selectAll()
    .where('workout_id', 'in', workouts.map((w) => w.id)).orderBy('order_index').execute()
  const distance = (d: string | null) => d ? Math.abs(Date.parse(d) - Date.parse(day)) : Infinity
  return workouts
    .sort((a, b) => distance(a.date) - distance(b.date) || (a.date ?? '').localeCompare(b.date ?? ''))
    .map((w) => {
      const own = exercises.filter((e) => e.workout_id === w.id && e.name.trim() !== '')
      const fits = new Set(rowsFittingSet(own, lift, loadKg))
      const rows: AnalysisLinkRow[] = own.map((e) => ({
        exerciseId: e.id, name: e.name, sets: e.sets, reps: e.reps, weight: e.weight,
        loadUsed: e.load_used, fits: fits.has(e),
      }))
      return {
        workoutId: w.id, date: w.date, workoutName: w.name, programId: w.programId, programName: w.programName,
        rows, suggestedExerciseId: fits.size === 1 ? [...fits][0].id : null,
      }
    })
}

/**
 * Why a link cannot be stored, or null when it can: the day must exist and be
 * in one of the athlete's programs, and the row must be on that day.
 */
export async function linkProblem(
  athleteId: string | null, workoutId: string | null, exerciseId: string | null,
): Promise<string | null> {
  if (!workoutId) return exerciseId ? 'Pick the training day too' : null
  if (!athleteId) return 'Pick whose set it is first'
  const db = getDb()
  const workout = await db.selectFrom('workouts')
    .innerJoin('programs', 'programs.id', 'workouts.program_id')
    .select('programs.athlete_id as athleteId')
    .where('workouts.id', '=', workoutId).executeTakeFirst()
  if (!workout) return 'That training day no longer exists'
  if (workout.athleteId !== athleteId) return "That training day is in another athlete's program"
  if (exerciseId) {
    const ex = await db.selectFrom('exercises').select('workout_id')
      .where('id', '=', exerciseId).executeTakeFirst()
    if (!ex || ex.workout_id !== workoutId) return 'That exercise is not on the training day'
  }
  return null
}

/**
 * D70, once, on the upgrade that added the link: every analysis of a Discord
 * clip attached to a day of the same athlete's program gets that day, and the
 * row when exactly one fits. Returns how many were linked.
 */
export async function backfillAnalysisLinks(): Promise<number> {
  const db = getDb()
  const pending = await db.selectFrom('video_analyses')
    .innerJoin('discord_media', 'discord_media.id', 'video_analyses.media_id')
    .innerJoin('workouts', 'workouts.id', 'discord_media.workout_id')
    .innerJoin('programs', 'programs.id', 'workouts.program_id')
    .select([
      'video_analyses.id as id', 'video_analyses.lift as lift', 'video_analyses.load_kg as loadKg',
      'workouts.id as workoutId',
    ])
    .where('video_analyses.workout_id', 'is', null)
    .whereRef('programs.athlete_id', '=', 'video_analyses.athlete_id')
    .execute()
  for (const a of pending) {
    const rows = await db.selectFrom('exercises').selectAll().where('workout_id', '=', a.workoutId).execute()
    const row = soleFit(rows, a.lift, a.loadKg)
    await db.updateTable('video_analyses')
      .set({ workout_id: a.workoutId, exercise_id: row?.id ?? null })
      .where('id', '=', a.id).execute()
  }
  return pending.length
}
