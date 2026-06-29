import { getDb } from '../db.js'
import { estimate1RM } from 'coachboard-shared/rpe'

// ---------------------------------------------------------------------------
// e1RM reference for the "Modern" export template's per-lift badge.
//
// The badge shows the athlete's current estimated 1-rep max for each main lift.
// Baseline = the athlete's latest stored max (the coach-maintained PR, which is
// itself a 1RM data point); raised by any higher e1RM the program's own logged
// sets imply (load_used + reps + RPE → estimate1RM). Keyed by main-lift keyword
// so the renderer can match an exercise name to its reference.
// ---------------------------------------------------------------------------

export const MAIN_LIFT_KEYWORDS = ['squat', 'bench', 'deadlift'] as const

type ExRow = { name: string; reps: string | null; load_used: string | null; rpe: string | null }

function keywordFor(name: string): (typeof MAIN_LIFT_KEYWORDS)[number] | null {
  const lower = name.toLowerCase()
  return MAIN_LIFT_KEYWORDS.find((k) => lower.includes(k)) ?? null
}

/** Current e1RM reference per main-lift keyword (e.g. { squat: 200, bench: 140 }). */
export async function getE1RMReference(
  athleteId: string | null,
  exercises: ExRow[],
): Promise<Record<string, number>> {
  const ref: Record<string, number> = {}

  // Baseline: the athlete's latest stored max per lift.
  if (athleteId) {
    const maxRows = await getDb()
      .selectFrom('athlete_maxes')
      .select(['lift_name', 'weight', 'recorded_at'])
      .where('athlete_id', '=', athleteId)
      .orderBy('recorded_at', 'desc')
      .execute()
    const seen = new Set<string>()
    for (const m of maxRows) {
      const kw = keywordFor(m.lift_name)
      if (!kw || seen.has(kw)) continue
      seen.add(kw) // latest row wins (rows are newest-first)
      if (Number.isFinite(m.weight) && m.weight > 0) ref[kw] = m.weight
    }
  }

  // Raise with any higher e1RM implied by the program's own logged sets.
  for (const ex of exercises) {
    if (!ex.load_used || !ex.rpe || !ex.reps) continue
    const kw = keywordFor(ex.name)
    if (!kw) continue
    const repsMatch = ex.reps.match(/\d+/)
    if (!repsMatch) continue
    const weight = parseFloat(ex.load_used.replace(',', '.'))
    const rpe = parseFloat(ex.rpe.replace(',', '.'))
    const reps = parseInt(repsMatch[0], 10)
    if (isNaN(weight) || isNaN(rpe) || isNaN(reps)) continue
    const est = estimate1RM(weight, reps, rpe)
    if (est === null) continue
    const rounded = Math.round(est)
    if (ref[kw] == null || rounded > ref[kw]) ref[kw] = rounded
  }

  return ref
}

/** e1RM reference for a given exercise name, or null when the lift has no reference. */
export function e1rmForExerciseName(name: string, ref: Record<string, number>): number | null {
  const kw = keywordFor(name)
  return kw && ref[kw] != null ? ref[kw] : null
}
