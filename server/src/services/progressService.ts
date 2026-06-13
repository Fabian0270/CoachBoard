import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'

export async function findProgressRecords(filters: { athlete_id?: string; metric_name?: string }) {
  let query = getDb().selectFrom('progress_records').selectAll()
  if (filters.athlete_id) query = query.where('athlete_id', '=', filters.athlete_id)
  if (filters.metric_name) query = query.where('metric_name', '=', filters.metric_name)
  return query.orderBy('recorded_at', 'desc').execute()
}

export async function createProgressRecord(data: {
  athlete_id: string
  metric_name: string
  value: number
  unit?: string | null
  recorded_at?: string
  notes?: string | null
}) {
  return getDb()
    .insertInto('progress_records')
    .values({
      id: uuidv4(),
      athlete_id: data.athlete_id,
      metric_name: data.metric_name,
      value: data.value,
      unit: data.unit ?? null,
      recorded_at: data.recorded_at ?? new Date().toISOString(),
      notes: data.notes ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function deleteProgressRecord(id: string) {
  return getDb().deleteFrom('progress_records').where('id', '=', id).returningAll().executeTakeFirst()
}
