import { getDb } from '../db.js'

// ---------------------------------------------------------------------------
// The bar speed an athlete's true 1RM actually moves at, per lift.
//
// Every velocity readout on the bar-path page is judged against this number,
// and the published band it falls back to is a population figure — the whole
// premise of velocity-based training is that it is individual. A coach who has
// measured it once should not have to retype it on the next clip, which is what
// happened while it lived in component state.
// ---------------------------------------------------------------------------

/** Sane bounds for a barbell at a maximum. Wider than any published band. */
const MIN_VELOCITY = 0.01
const MAX_VELOCITY = 2

/** Every lift this athlete has a measured 1RM velocity for, keyed by lift id. */
export async function getAthleteMvts(athleteId: string): Promise<Record<string, number>> {
  const rows = await getDb()
    .selectFrom('athlete_mvt')
    .select(['lift', 'velocity'])
    .where('athlete_id', '=', athleteId)
    .execute()
  return Object.fromEntries(rows.map((r) => [r.lift, r.velocity]))
}

/**
 * Records, replaces, or clears one lift's value.
 *
 * A null velocity deletes rather than storing a zero: "not measured" and
 * "measured as nothing" are different, and only the first should fall back to
 * the published band.
 */
export async function setAthleteMvt(
  athleteId: string,
  lift: string,
  velocity: number | null,
): Promise<void> {
  const db = getDb()
  if (velocity == null) {
    await db
      .deleteFrom('athlete_mvt')
      .where('athlete_id', '=', athleteId)
      .where('lift', '=', lift)
      .execute()
    return
  }
  if (!Number.isFinite(velocity) || velocity < MIN_VELOCITY || velocity > MAX_VELOCITY) {
    throw new Error('That is not a plausible bar speed')
  }
  // One row per athlete+lift, so re-measuring replaces rather than accumulating
  // a history nothing reads.
  await db
    .insertInto('athlete_mvt')
    .values({ athlete_id: athleteId, lift, velocity, updated_at: new Date().toISOString() })
    .onConflict((oc) =>
      oc.columns(['athlete_id', 'lift']).doUpdateSet({
        velocity,
        updated_at: new Date().toISOString(),
      }),
    )
    .execute()
}
