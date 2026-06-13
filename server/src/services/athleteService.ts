import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'

export async function findAllAthletes() {
  return getDb().selectFrom('athletes').selectAll().orderBy('name').execute()
}

export async function findAthleteById(id: string) {
  return getDb().selectFrom('athletes').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function createAthlete(data: {
  name: string
  email?: string | null
  sport?: string | null
  date_of_birth?: string | null
  notes?: string | null
}) {
  const now = new Date().toISOString()
  return getDb()
    .insertInto('athletes')
    .values({
      id: uuidv4(),
      name: data.name,
      email: data.email ?? null,
      sport: data.sport ?? null,
      date_of_birth: data.date_of_birth ?? null,
      notes: data.notes ?? null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function deleteAthlete(id: string) {
  return getDb().deleteFrom('athletes').where('id', '=', id).returningAll().executeTakeFirst()
}

// ---------------------------------------------------------------------------
// Athlete maxes (PRs) — history is kept; "current max" = latest row per lift
// ---------------------------------------------------------------------------

export async function findMaxesByAthlete(athleteId: string) {
  return getDb()
    .selectFrom('athlete_maxes')
    .selectAll()
    .where('athlete_id', '=', athleteId)
    .orderBy('lift_name')
    .orderBy('recorded_at', 'desc')
    .execute()
}

export async function createAthleteMax(data: {
  athlete_id: string
  lift_name: string
  weight: number
  unit?: string | null
  recorded_at?: string
  notes?: string | null
}) {
  return getDb()
    .insertInto('athlete_maxes')
    .values({
      id: uuidv4(),
      athlete_id: data.athlete_id,
      lift_name: data.lift_name,
      weight: data.weight,
      unit: data.unit ?? 'kg',
      recorded_at: data.recorded_at ?? new Date().toISOString().slice(0, 10),
      notes: data.notes ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function deleteAthleteMax(id: string, athleteId: string) {
  return getDb()
    .deleteFrom('athlete_maxes')
    .where('id', '=', id)
    .where('athlete_id', '=', athleteId)
    .returningAll()
    .executeTakeFirst()
}
