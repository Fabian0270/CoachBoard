import { getDb } from '../db.js'

// ---------------------------------------------------------------------------
// An athlete's reference rep per lift (BP28): one saved rep that every new
// analysis of that lift is drawn against. One per athlete and lift; marking
// another replaces it.
// ---------------------------------------------------------------------------

export interface ReferenceRep {
  analysisId: string
  repIndex: number
}

export class ReferenceRepRefused extends Error {}

/** Every lift this athlete has a reference rep for, keyed by lift id. */
export async function getReferenceReps(athleteId: string): Promise<Record<string, ReferenceRep>> {
  const rows = await getDb()
    .selectFrom('reference_reps')
    .select(['lift', 'analysis_id', 'rep_index'])
    .where('athlete_id', '=', athleteId)
    .execute()
  return Object.fromEntries(rows.map((r) => [r.lift, { analysisId: r.analysis_id, repIndex: r.rep_index }]))
}

/**
 * Marks, replaces or clears one lift's reference rep.
 *
 * The set must be this athlete's, of this lift, and hold that rep — a
 * reference pointing anywhere else would draw the wrong lift over the video.
 */
export async function setReferenceRep(athleteId: string, lift: string, analysisId: string | null, repIndex = 0): Promise<void> {
  const db = getDb()
  if (analysisId == null) {
    await db.deleteFrom('reference_reps').where('athlete_id', '=', athleteId).where('lift', '=', lift).execute()
    return
  }
  const analysis = await db
    .selectFrom('video_analyses')
    .select(['athlete_id', 'lift', 'metrics'])
    .where('id', '=', analysisId)
    .executeTakeFirst()
  if (!analysis) throw new ReferenceRepRefused('That saved set no longer exists')
  if (analysis.athlete_id !== athleteId) throw new ReferenceRepRefused('That set belongs to another athlete')
  if (analysis.lift !== lift) throw new ReferenceRepRefused('That set is a different lift')
  const metrics = analysis.metrics ? (JSON.parse(analysis.metrics) as { index: number }[]) : []
  if (!metrics.some((m) => m.index === repIndex)) throw new ReferenceRepRefused('That set has no such rep')

  const now = new Date().toISOString()
  await db
    .insertInto('reference_reps')
    .values({ athlete_id: athleteId, lift, analysis_id: analysisId, rep_index: repIndex, updated_at: now })
    .onConflict((oc) => oc.columns(['athlete_id', 'lift']).doUpdateSet({ analysis_id: analysisId, rep_index: repIndex, updated_at: now }))
    .execute()
}
