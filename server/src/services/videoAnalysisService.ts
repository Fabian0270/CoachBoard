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
  posted_at?: string | null
  link_workout_id?: string | null
  link_date?: string | null
  link_workout_name?: string | null
  link_program_id?: string | null
  link_program_name?: string | null
  link_exercise_id?: string | null
  link_exercise_name?: string | null
  link_exercise_workout_id?: string | null
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
    liftedAt: row.posted_at ?? row.created_at,
    // A deleted day reads as no link; a deleted row as a link to the day only.
    link: row.link_workout_id && row.link_program_id
      ? {
          workoutId: row.link_workout_id,
          date: row.link_date ?? null,
          workoutName: row.link_workout_name ?? '',
          programId: row.link_program_id,
          programName: row.link_program_name ?? '',
          exerciseId: row.link_exercise_id && row.link_exercise_workout_id === row.link_workout_id ? row.link_exercise_id : null,
          exerciseName: row.link_exercise_id && row.link_exercise_workout_id === row.link_workout_id ? row.link_exercise_name ?? null : null,
        }
      : null,
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
    // L2: the day and row the set was, with what the saved page shows of them.
    .leftJoin('workouts as lw', 'lw.id', 'video_analyses.workout_id')
    .leftJoin('programs as lp', 'lp.id', 'lw.program_id')
    .leftJoin('exercises as le', 'le.id', 'video_analyses.exercise_id')
    .select([
      'lw.id as link_workout_id', 'lw.scheduled_date as link_date', 'lw.name as link_workout_name',
      'lp.id as link_program_id', 'lp.name as link_program_name',
      'le.id as link_exercise_id', 'le.name as link_exercise_name', 'le.workout_id as link_exercise_workout_id',
    ])
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
      // When the set was lifted, as near as the app knows (BP33): a synced
      // clip's posting time, else when the set was saved. A coach clearing an
      // inbox on Thursday must not turn Tuesday's sets into Thursday's.
      (eb) => eb.selectFrom('discord_media').select('discord_media.posted_at').whereRef('discord_media.id', '=', 'video_analyses.media_id').as('posted_at'),
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
      workout_id: input.workoutId ?? null,
      exercise_id: input.workoutId ? input.exerciseId ?? null : null,
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
    // The training day belonged to the previous athlete's program (L2).
    .set({ athlete_id: athleteId, workout_id: null, exercise_id: null, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .executeTakeFirst()
  if (Number(res.numUpdatedRows ?? 0n) === 0) return null

  const row = await baseQuery().where('video_analyses.id', '=', id).executeTakeFirst()
  return row ? toDto(row as AnalysisRow) : null
}

/**
 * Corrects what the set was. Only the fields given change; `null` clears one.
 * The tracked path and metrics are never touched — see the route.
 */
export async function updateAnalysisContext(
  id: string,
  change: {
    athleteId?: string | null
    lift?: string | null
    loadKg?: number | null
    calledRpe?: number | null
    metric?: string | null
    /** The set's reps, after one was struck off (or put back). */
    metrics?: Record<string, unknown>[]
    /** The coach's note on the set. Blank is stored as null. */
    notes?: string | null
    /** The training day and row (L2). A day given without a row clears the row. */
    workoutId?: string | null
    exerciseId?: string | null
  },
): Promise<VideoAnalysisDto | null> {
  // Another athlete's set cannot stay on the first athlete's training day.
  let link: { workout_id?: string | null; exercise_id?: string | null } = {}
  if (change.workoutId !== undefined) {
    link = { workout_id: change.workoutId, exercise_id: change.workoutId ? change.exerciseId ?? null : null }
  } else if (change.athleteId !== undefined) {
    const current = await getDb().selectFrom('video_analyses').select('athlete_id').where('id', '=', id).executeTakeFirst()
    if (current && current.athlete_id !== change.athleteId) link = { workout_id: null, exercise_id: null }
  }
  const res = await getDb()
    .updateTable('video_analyses')
    .set({
      ...link,
      ...(change.athleteId !== undefined ? { athlete_id: change.athleteId } : {}),
      ...(change.lift !== undefined ? { lift: change.lift } : {}),
      ...(change.loadKg !== undefined ? { load_kg: change.loadKg } : {}),
      ...(change.calledRpe !== undefined ? { called_rpe: change.calledRpe } : {}),
      ...(change.metric !== undefined ? { metric: change.metric } : {}),
      ...(change.metrics !== undefined ? { metrics: JSON.stringify(change.metrics) } : {}),
      ...(change.notes !== undefined ? { notes: change.notes?.trim() || null } : {}),
      updated_at: new Date().toISOString(),
    })
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

/**
 * Absolute path of the analysis's OWN copy, or null if it has none on disk.
 *
 * Async because `videoPath` stats the file rather than trusting the row: a row
 * can name a clip that is no longer there, and a restored backup is the ordinary
 * case for that, since a backup carries the database but not the media folder.
 * Returning the path regardless would have `res.sendFile` throw into the global
 * handler and report a server fault, instead of the route's own "no video kept
 * for this analysis" — which is both true and actionable.
 */
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
