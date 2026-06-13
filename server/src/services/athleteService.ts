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
