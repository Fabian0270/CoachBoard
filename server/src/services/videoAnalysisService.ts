import { sql } from 'kysely'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { deleteVideo, sweepOrphanVideos, videoPath } from './analysisVideoStore.js'
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
  lift: string | null
  load_kg: number | null
  called_rpe: number | null
  metric: string | null
  video_path: string | null
  video_bytes: number | null
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
    lift: row.lift,
    loadKg: row.load_kg,
    calledRpe: row.called_rpe,
    metric: row.metric,
    // Either form of ownership counts. The path is deliberately not exposed:
    // the client asks for /api/analysis/:id/video and never handles a filesystem
    // path, which keeps the file route the only way to reach the bytes.
    hasVideo: !!row.video_path || !!row.media_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * `withTrack: false` omits the path itself.
 *
 * A track is up to 20 000 points, and the velocity panel lists an athlete's
 * whole history purely to read the load and per-rep metrics off each row —
 * shipping every path with it would be megabytes to display a handful of dots.
 */
function baseQuery(withTrack = true) {
  return getDb()
    .selectFrom('video_analyses')
    .leftJoin('athletes', 'athletes.id', 'video_analyses.athlete_id')
    .select(
      withTrack
        ? sql<string>`video_analyses.track`.as('track')
        : sql<string>`'[]'`.as('track'),
    )
    .select([
      'video_analyses.id as id',
      'video_analyses.media_id as media_id',
      'video_analyses.athlete_id as athlete_id',
      'video_analyses.source_label as source_label',
      'video_analyses.calibration as calibration',
      'video_analyses.metrics as metrics',
      'video_analyses.notes as notes',
      'video_analyses.lift as lift',
      'video_analyses.load_kg as load_kg',
      'video_analyses.called_rpe as called_rpe',
      'video_analyses.metric as metric',
      'video_analyses.video_path as video_path',
      'video_analyses.video_bytes as video_bytes',
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
      lift: input.lift,
      load_kg: input.loadKg,
      called_rpe: input.calledRpe,
      metric: input.metric,
      video_path: input.videoPath ?? null,
      video_bytes: input.videoBytes ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute()

  const row = await baseQuery().where('video_analyses.id', '=', id).executeTakeFirstOrThrow()
  return toDto(row as AnalysisRow)
}

/** Every saved analysis, newest first. Optionally scoped to one video. */
export async function listAnalyses(
  opts: { mediaId?: string; athleteId?: string; withTrack?: boolean } = {},
): Promise<VideoAnalysisDto[]> {
  let q = baseQuery(opts.withTrack ?? true)
  if (opts.mediaId) q = q.where('video_analyses.media_id', '=', opts.mediaId)
  if (opts.athleteId) q = q.where('video_analyses.athlete_id', '=', opts.athleteId)
  const rows = await q.orderBy('video_analyses.created_at', 'desc').execute()
  return rows.map((r) => toDto(r as AnalysisRow))
}

export async function getAnalysis(id: string): Promise<VideoAnalysisDto | null> {
  const row = await baseQuery().where('video_analyses.id', '=', id).executeTakeFirst()
  return row ? toDto(row as AnalysisRow) : null
}

/**
 * Attaches an analysis to an athlete, or detaches it.
 *
 * An analysis taken from a local file has no athlete until someone says whose
 * it is, and before this there was no way to say so afterwards — an orphan
 * stayed an orphan, invisible to every profile it should have been feeding.
 */
export async function setAnalysisAthlete(
  id: string,
  athleteId: string | null,
): Promise<VideoAnalysisDto | null> {
  const res = await getDb()
    .updateTable('video_analyses')
    .set({ athlete_id: athleteId, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .executeTakeFirst()
  if (Number(res.numUpdatedRows ?? 0n) === 0) return null

  const row = await baseQuery().where('video_analyses.id', '=', id).executeTakeFirst()
  return row ? toDto(row as AnalysisRow) : null
}

/**
 * Deletes the analysis and the video it owns.
 *
 * The file is read BEFORE the row goes, or its path is gone with it and the
 * video is stranded on disk forever. A Discord clip is untouched — the analysis
 * only referenced it, and the coach's synced library is not this function's to
 * delete from.
 */
export async function deleteAnalysis(id: string): Promise<boolean> {
  const owned = await getDb()
    .selectFrom('video_analyses')
    .select('video_path')
    .where('id', '=', id)
    .executeTakeFirst()

  const res = await getDb().deleteFrom('video_analyses').where('id', '=', id).executeTakeFirst()
  const deleted = Number(res.numDeletedRows ?? 0n) > 0
  // Only after the row is actually gone: a failed delete must not leave a row
  // pointing at a file that no longer exists.
  if (deleted) await deleteVideo(owned?.video_path)
  return deleted
}

/** Whether a video has any saved analysis — the retention and delete carve-out. */
export async function countAnalysesForMedia(mediaId: string): Promise<number> {
  const row = await getDb()
    .selectFrom('video_analyses')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('media_id', '=', mediaId)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

/** Absolute path of the analysis's OWN copy, or null if it has none on disk. */
export async function ownedVideoPath(id: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom('video_analyses')
    .select('video_path')
    .where('id', '=', id)
    .executeTakeFirst()
  return row?.video_path ? videoPath(row.video_path) : null
}

/**
 * Deletes stored videos no analysis claims any more.
 *
 * Needed because deleting a file can legitimately fail while a player still
 * holds it open on Windows, which would otherwise strand it forever — the same
 * reason sweepOrphanThumbs exists. Runs at launch rather than with the Discord
 * sync, since an analysis video has nothing to do with whether Discord is set up.
 */
export async function sweepAnalysisVideos(): Promise<number> {
  const rows = await getDb()
    .selectFrom('video_analyses')
    .select('video_path')
    .where('video_path', 'is not', null)
    .execute()
  return sweepOrphanVideos(new Set(rows.map((r) => r.video_path as string)))
}
