import { getDb } from '../db.js'
import { exerciseMatchesKeyword, parseCaption } from './captionMatcher.js'
import type { CaptionLogCandidates, CaptionLogRow, ParsedCaption } from 'coachboard-shared/discord'

// ---------------------------------------------------------------------------
// Logging a caption's result on the program (L1, D66).
//
// An athlete posts "180x3 @8" with their video. When the coach attaches the
// video to the day, the caption's load, RPE and — when they differ from the
// plan — reps can be written onto one row of that day, so the report's e1RM
// and the Progress tab pick the set up without anyone typing it in.
//
// Never overwrites: a row that already holds a Load Used or RPE is offered as
// "already logged" and refused here. Reps go into `reps_done`, never into the
// planned reps and never into the exercise note (the coach's cue column, D7).
// ---------------------------------------------------------------------------

export class CaptionLogError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const filled = (s: string | null) => !!s && s.trim() !== ''

/** Within 7.5 % of the planned load, the same tolerance the workout suggester uses. */
const loadAgrees = (planned: number | null, kg: number) => planned != null && planned > 0 && Math.abs(planned - kg) / planned <= 0.075

/** Which rows of the day the caption fits: the lift named, narrowed by load. */
export function fittingRows<T extends { name: string; weight: number | null }>(rows: T[], caption: ParsedCaption): Set<T> {
  const byLift = caption.liftKeywords.length > 0
    ? rows.filter((r) => exerciseMatchesKeyword(r.name, caption.liftKeywords))
    : []
  const pool = byLift.length > 0 ? byLift : rows
  const byLoad = caption.weightKg != null ? pool.filter((r) => loadAgrees(r.weight, caption.weightKg!)) : []
  if (byLoad.length > 0) return new Set(byLoad)
  // The lift named but no load matched (no Load Cap, or a heavier day than
  // planned): every row of that lift still fits.
  return new Set(byLift)
}

/** "180", "182.5" — the way a coach types Load Used. */
export const formatLoad = (kg: number) => String(Math.round(kg * 10) / 10)

/** The reps to store as done, or null when they are what was planned. */
export function repsDone(planned: string | null, captionReps: number | null): string | null {
  if (captionReps == null) return null
  return (planned ?? '').trim() === String(captionReps) ? null : String(captionReps)
}

async function mediaCaption(mediaId: string) {
  const media = await getDb().selectFrom('discord_media')
    .select(['id', 'workout_id', 'message_content'])
    .where('id', '=', mediaId).executeTakeFirst()
  if (!media) throw new CaptionLogError('Video not found', 404)
  const caption = parseCaption(media.message_content)
  return { media, caption }
}

/** The rows of a day the caption on this video could be logged on. */
export async function logCandidates(mediaId: string, workoutId: string): Promise<CaptionLogCandidates> {
  const { caption } = await mediaCaption(mediaId)
  const exercises = await getDb().selectFrom('exercises').selectAll()
    .where('workout_id', '=', workoutId).orderBy('order_index').execute()
  const fits = caption.weightKg != null ? fittingRows(exercises, caption) : new Set<typeof exercises[number]>()
  const rows: CaptionLogRow[] = exercises
    .filter((e) => e.name.trim() !== '')
    .map((e) => ({
      exerciseId: e.id,
      name: e.name,
      sets: e.sets,
      reps: e.reps,
      weight: e.weight,
      intensity: e.intensity,
      loadUsed: e.load_used,
      rpe: e.rpe,
      alreadyLogged: filled(e.load_used) || filled(e.rpe),
      fits: fits.has(e),
    }))
  return { caption, rows }
}

/**
 * Write the caption's result onto one row. The video must already be attached
 * to that row's day. Returns the updated row.
 */
export async function logCaption(mediaId: string, exerciseId: string) {
  const db = getDb()
  const { media, caption } = await mediaCaption(mediaId)
  if (caption.weightKg == null) throw new CaptionLogError('The caption has no load to log', 400)
  const ex = await db.selectFrom('exercises').selectAll().where('id', '=', exerciseId).executeTakeFirst()
  if (!ex) throw new CaptionLogError('Exercise not found', 404)
  if (media.workout_id !== ex.workout_id) throw new CaptionLogError('Attach the video to this day first', 409)
  if (filled(ex.load_used) || filled(ex.rpe)) {
    throw new CaptionLogError(`Already logged: ${[ex.load_used, ex.rpe && `@${ex.rpe}`].filter(filled).join(' ')}`, 409)
  }
  await db.updateTable('exercises').set({
    load_used: formatLoad(caption.weightKg),
    ...(caption.rpe != null ? { rpe: String(caption.rpe) } : {}),
    reps_done: repsDone(ex.reps, caption.reps),
  }).where('id', '=', exerciseId).execute()
  return db.selectFrom('exercises').selectAll().where('id', '=', exerciseId).executeTakeFirstOrThrow()
}
