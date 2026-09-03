import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import type {
  CalibrationDto,
  SaveVideoAnalysisInput,
  VideoAnalysisDto,
} from 'coachboard-shared/videoAnalysis'
import type { RepMetrics, Sample } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// Saved bar-path analyses (Feature 11b).
//
// The path, calibration and per-rep metrics are stored as JSON text. An
// analysis is only ever read and written whole, it is a few hundred points
// (~10 KB), and keeping it in SQLite means it is covered by the existing
// database backup — unlike the video files themselves, which are not.
// ---------------------------------------------------------------------------

interface AnalysisRow {
  id: string
  media_id: string | null
  athlete_id: string | null
  source_label: string
  track: string
  calibration: string | null
  metrics: string | null
  notes: string | null
  created_at: string
  updated_at: string
  athlete_name?: string | null
}

/**
 * Stored JSON is parsed defensively.
 *
 * These columns are written by this app, but a restored backup or a
 * hand-edited database should degrade to "no path" rather than throwing an
 * unhandled error out of a list endpoint and taking the whole page down.
 */
function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toDto(row: AnalysisRow): VideoAnalysisDto {
  return {
    id: row.id,
    mediaId: row.media_id,
    athleteId: row.athlete_id,
    athleteName: row.athlete_name ?? null,
    sourceLabel: row.source_label,
    track: parseJson<Sample[]>(row.track, []),
    calibration: parseJson<CalibrationDto | null>(row.calibration, null),
    metrics: parseJson<RepMetrics[]>(row.metrics, []),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function baseQuery() {
  return getDb()
    .selectFrom('video_analyses')
    .leftJoin('athletes', 'athletes.id', 'video_analyses.athlete_id')
    .select([
      'video_analyses.id as id',
      'video_analyses.media_id as media_id',
      'video_analyses.athlete_id as athlete_id',
      'video_analyses.source_label as source_label',
      'video_analyses.track as track',
      'video_analyses.calibration as calibration',
      'video_analyses.metrics as metrics',
      'video_analyses.notes as notes',
      'video_analyses.created_at as created_at',
      'video_analyses.updated_at as updated_at',
      'athletes.name as athlete_name',
    ])
}

export async function saveAnalysis(input: SaveVideoAnalysisInput): Promise<VideoAnalysisDto> {
  const now = new Date().toISOString()
  const id = uuidv4()
  await getDb()
    .insertInto('video_analyses')
    .values({
      id,
      media_id: input.mediaId,
      athlete_id: input.athleteId,
      source_label: input.sourceLabel,
      track: JSON.stringify(input.track),
      calibration: input.calibration ? JSON.stringify(input.calibration) : null,
      metrics: JSON.stringify(input.metrics),
      notes: input.notes,
      created_at: now,
      updated_at: now,
    })
    .execute()

  const row = await baseQuery().where('video_analyses.id', '=', id).executeTakeFirstOrThrow()
  return toDto(row as AnalysisRow)
}

/** Every saved analysis, newest first. Optionally scoped to one video. */
export async function listAnalyses(opts: { mediaId?: string; athleteId?: string } = {}): Promise<
  VideoAnalysisDto[]
> {
  let q = baseQuery()
  if (opts.mediaId) q = q.where('video_analyses.media_id', '=', opts.mediaId)
  if (opts.athleteId) q = q.where('video_analyses.athlete_id', '=', opts.athleteId)
  const rows = await q.orderBy('video_analyses.created_at', 'desc').execute()
  return rows.map((r) => toDto(r as AnalysisRow))
}

export async function getAnalysis(id: string): Promise<VideoAnalysisDto | null> {
  const row = await baseQuery().where('video_analyses.id', '=', id).executeTakeFirst()
  return row ? toDto(row as AnalysisRow) : null
}

export async function deleteAnalysis(id: string): Promise<boolean> {
  const res = await getDb().deleteFrom('video_analyses').where('id', '=', id).executeTakeFirst()
  return Number(res.numDeletedRows ?? 0n) > 0
}

/** Whether a video has any saved analysis — used by the retention carve-out. */
export async function countAnalysesForMedia(mediaId: string): Promise<number> {
  const row = await getDb()
    .selectFrom('video_analyses')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('media_id', '=', mediaId)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}
