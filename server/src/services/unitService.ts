import { getDb } from '../db.js'
import { convertLoad, roundToPlates, unitOf, type LoadUnit } from 'coachboard-shared/units'

// ---------------------------------------------------------------------------
// kg / lb (S3, D76–D79).
//
// The unit new athletes start with is an app setting (D78). An athlete's unit
// is changed only here, because a change may convert their numbers: when the
// coach says yes (D77), every load that is a number — Load Cap, a numeric
// Load Used, their maxes, their bar path loads — is converted and rounded to
// the plates of the new unit. Free text (Intensity "RPE 8 @225", a Load Used
// of "BW+20") is never touched.
// ---------------------------------------------------------------------------

const DEFAULT_UNIT_KEY = 'default_unit'

export async function getDefaultUnit(): Promise<LoadUnit> {
  const row = await getDb().selectFrom('app_settings').select('value').where('key', '=', DEFAULT_UNIT_KEY).executeTakeFirst()
  return unitOf(row?.value)
}

export async function setDefaultUnit(unit: LoadUnit): Promise<void> {
  await getDb().insertInto('app_settings').values({ key: DEFAULT_UNIT_KEY, value: unit })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: unit })).execute()
}

/**
 * The unit a program's loads are in: its athlete's, or — for a template with
 * no athlete — the default new athletes get.
 */
export async function programUnit(athleteId: string | null): Promise<LoadUnit> {
  if (!athleteId) return getDefaultUnit()
  const row = await getDb().selectFrom('athletes').select('unit').where('id', '=', athleteId).executeTakeFirst()
  return unitOf(row?.unit)
}

/** A Load Used that is just a number ("140", "102,5", "140 kg"); null for anything else. */
export function numericLoad(text: string | null): number | null {
  if (!text) return null
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:kg|kgs|lb|lbs)?\s*$/i.exec(text)
  return m ? Number(m[1].replace(',', '.')) : null
}

/** What switching would convert, so the coach knows before saying yes. */
export interface UnitImpact {
  loadCaps: number
  loadsUsed: number
  maxes: number
  barPathSets: number
}

async function programExerciseIds(athleteId: string) {
  return getDb().selectFrom('exercises')
    .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
    .innerJoin('programs', 'programs.id', 'workouts.program_id')
    .select(['exercises.id as id', 'exercises.weight as weight', 'exercises.load_used as load_used'])
    .where('programs.athlete_id', '=', athleteId)
    .execute()
}

export async function unitImpact(athleteId: string): Promise<UnitImpact> {
  const db = getDb()
  const rows = await programExerciseIds(athleteId)
  const maxes = await db.selectFrom('athlete_maxes').select('id').where('athlete_id', '=', athleteId).execute()
  const sets = await db.selectFrom('video_analyses').select('id').where('athlete_id', '=', athleteId).where('load_kg', 'is not', null).execute()
  return {
    loadCaps: rows.filter((r) => r.weight != null).length,
    loadsUsed: rows.filter((r) => numericLoad(r.load_used) != null).length,
    maxes: maxes.length,
    barPathSets: sets.length,
  }
}

/** "102.5", "140": a converted Load Used, written the way a coach types one. */
const asText = (n: number) => String(Math.round(n * 10) / 10)

/**
 * Sets the athlete's unit; with `convert`, converts their numbers too, all in
 * one transaction. Returns null when there is no such athlete.
 */
export async function switchAthleteUnit(athleteId: string, to: LoadUnit, convert: boolean) {
  const db = getDb()
  const athlete = await db.selectFrom('athletes').select(['id', 'unit']).where('id', '=', athleteId).executeTakeFirst()
  if (!athlete) return null
  const from = unitOf(athlete.unit)
  if (from === to) return { unit: to, converted: false }
  const rows = convert ? await programExerciseIds(athleteId) : []
  const c = (n: number) => roundToPlates(convertLoad(n, from, to), to)

  await db.transaction().execute(async (trx) => {
    await trx.updateTable('athletes').set({ unit: to, updated_at: new Date().toISOString() }).where('id', '=', athleteId).execute()
    if (!convert) return
    for (const r of rows) {
      const used = numericLoad(r.load_used)
      if (r.weight == null && used == null) continue
      await trx.updateTable('exercises').set({
        ...(r.weight != null ? { weight: c(r.weight) } : {}),
        ...(used != null ? { load_used: asText(c(used)) } : {}),
      }).where('id', '=', r.id).execute()
    }
    const maxes = await trx.selectFrom('athlete_maxes').select(['id', 'weight', 'unit']).where('athlete_id', '=', athleteId).execute()
    for (const m of maxes) {
      // A max is converted from its own recorded unit, in case it ever differed.
      await trx.updateTable('athlete_maxes')
        .set({ weight: roundToPlates(convertLoad(m.weight, unitOf(m.unit), to), to), unit: to })
        .where('id', '=', m.id).execute()
    }
    const sets = await trx.selectFrom('video_analyses').select(['id', 'load_kg']).where('athlete_id', '=', athleteId).where('load_kg', 'is not', null).execute()
    for (const s of sets) {
      await trx.updateTable('video_analyses').set({ load_kg: c(s.load_kg!) }).where('id', '=', s.id).execute()
    }
  })
  return { unit: to, converted: convert }
}
