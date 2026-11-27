import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { log, logError } from '../lib/logger.js'
import { homeCurrency } from './ratesService.js'
import { todayIso } from './paymentService.js'
import { adoptVideoFile, deleteVideo } from './analysisVideoStore.js'
import { saveAnalysis } from './videoAnalysisService.js'
import { SAMPLE_LIFT, SAMPLE_LIFT_CALIBRATION, SAMPLE_LIFT_FILE, SAMPLE_LIFT_METRICS, sampleLiftTrack } from './sampleLift.js'

// ---------------------------------------------------------------------------
// The sample athlete (S2 / T7, D9, D15, D111).
//
// The first-start tour runs on it, so every stop shows real content: a
// fictional powerlifter in kg with maxes, a finished 4-week block with the
// athlete's results logged (getting stronger over it, so Progress has
// something to show), a drafted next block, and one payment. It is
// loaded only when asked for (D9), marked `is_sample`, labelled "Sample"
// everywhere, and left out of everything that describes the coach's real
// business: the learned style, the dashboard counts, the needs-attention list,
// revenue and payment reminders. Removing it takes everything it owns.
//
// It also has one saved bar path analysis (D110): a real squat filmed from
// the side, whose clip ships with the app (client/public/sample) and is
// copied into the media folder like any kept video.
//
// Dates are laid out around today, so the finished block always ended last
// week and the draft always starts next Monday, whenever it is loaded.
// ---------------------------------------------------------------------------

export const SAMPLE_NAME = 'Sample Athlete'

const MAXES = { Squat: 180, 'Bench Press': 125, Deadlift: 215 }

/** Monday of the week `iso` falls in (local dates as YYYY-MM-DD). */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const plates = (kg: number) => Math.round(kg / 2.5) * 2.5

interface Row { name: string; sets: string; reps: string; pct?: number; of?: keyof typeof MAXES; weight?: number; rpe?: (week: number) => string; note?: string }

/**
 * The block: 3 days a week, the competition lifts climbing every week, the
 * RPE with them. No deload at the end: the tour shows this block on the
 * Progress tab, and a deload as the latest week read as the athlete getting
 * weaker ("-16.5 kg since 19 Oct", seen in the packaged app).
 */
function day(dayIndex: number, week: number): Row[] {
  const climb = [0, 0.04, 0.08, 0.12][week]
  const pct = (base: number) => Math.round((base + climb) * 100) / 100
  const rpe = (start: number) => (w: number) => String(start + w * 0.5)
  if (dayIndex === 0) return [
    { name: 'Squat', sets: '4', reps: '5', pct: pct(0.72), of: 'Squat', rpe: rpe(7) },
    { name: 'Bench Press', sets: '4', reps: '6', pct: pct(0.7), of: 'Bench Press', rpe: rpe(7) },
    { name: 'Romanian Deadlift', sets: '3', reps: '8', weight: plates(MAXES.Deadlift * 0.5), rpe: () => '7' },
  ]
  if (dayIndex === 1) return [
    { name: 'Deadlift', sets: '4', reps: '4', pct: pct(0.75), of: 'Deadlift', rpe: rpe(7) },
    { name: 'Close-Grip Bench Press', sets: '3', reps: '8', weight: plates(MAXES['Bench Press'] * 0.6), rpe: () => '7.5' },
    { name: 'Bulgarian Split Squat', sets: '3', reps: '10', weight: 20, rpe: () => '8' },
  ]
  return [
    { name: 'Squat', sets: '3', reps: '3', pct: pct(0.8), of: 'Squat', rpe: rpe(7.5) },
    { name: 'Bench Press', sets: '5', reps: '3', pct: pct(0.78), of: 'Bench Press', rpe: rpe(7.5) },
    { name: 'Barbell Row', sets: '4', reps: '8', weight: 70, rpe: () => '7' },
  ]
}

export interface SampleStatus {
  loaded: boolean
  athleteId: string | null
  /** The sample's saved bar path analysis, when it has one. */
  analysisId: string | null
}

/** Where the bundled sample clip lives: the client build's sample folder. Set by createApp. */
let clipDir: string | null = null
export function configureSampleClips(dir: string | null): void {
  clipDir = dir
}

export async function sampleStatus(): Promise<SampleStatus> {
  const row = await getDb().selectFrom('athletes').select('id').where('is_sample', '=', 1).executeTakeFirst()
  const analysis = row
    ? await getDb().selectFrom('video_analyses').select('id').where('athlete_id', '=', row.id).orderBy('created_at').executeTakeFirst()
    : undefined
  return { loaded: !!row, athleteId: row?.id ?? null, analysisId: analysis?.id ?? null }
}

/**
 * The sample's squat, with its own copy of the clip. Best-effort: without the
 * clip (a dev server with no client build) the sample loads without it, and the
 * tour's bar path stop falls back to the empty page.
 */
async function addSampleLift(athleteId: string): Promise<void> {
  const src = clipDir ? path.join(clipDir, SAMPLE_LIFT_FILE) : null
  if (!src || !fs.existsSync(src)) {
    log(`Sample lift clip not found (${src ?? 'no client build'}); the sample has no analysis`)
    return
  }
  try {
    const stored = await adoptVideoFile(src)
    await saveAnalysis({
      mediaId: null, athleteId, sourceLabel: SAMPLE_LIFT.sourceLabel,
      track: sampleLiftTrack(), calibration: SAMPLE_LIFT_CALIBRATION, metrics: SAMPLE_LIFT_METRICS,
      notes: SAMPLE_LIFT.notes, lift: SAMPLE_LIFT.lift, loadKg: SAMPLE_LIFT.loadKg, calledRpe: null, metric: null,
      videoPath: stored.relPath, videoBytes: stored.bytes,
    })
  } catch (err) {
    logError('Could not add the sample lift', err)
  }
}

/** Load the sample athlete, or return the one already there. */
export async function loadSampleAthlete(today = todayIso()): Promise<SampleStatus> {
  const existing = await sampleStatus()
  if (existing.loaded) return existing
  const currency = await homeCurrency()
  const now = new Date().toISOString()
  const athleteId = uuidv4()
  // The finished block ended last Sunday; the draft starts next Monday.
  const thisMonday = mondayOf(today)
  const firstStart = addDays(thisMonday, -28)
  const nextStart = addDays(thisMonday, 7)

  await getDb().transaction().execute(async (trx) => {
    await trx.insertInto('athletes').values({
      id: athleteId, name: SAMPLE_NAME, email: null, sport: 'Powerlifting', weight_class: '83', height_cm: 178,
      date_of_birth: null, archived: 0, unit: 'kg', is_sample: 1,
      notes: 'A made-up athlete for trying CoachBoard. Remove it any time from Settings → Help.',
      created_at: now, updated_at: now,
    }).execute()

    for (const [lift, weight] of Object.entries(MAXES)) {
      await trx.insertInto('athlete_maxes').values({
        id: uuidv4(), athlete_id: athleteId, lift_name: lift, weight, unit: 'kg',
        recorded_at: addDays(firstStart, -3), notes: null,
      }).execute()
    }

    const block = async (opts: { name: string; start: string; status: string; done: boolean; bump: number }) => {
      const programId = uuidv4()
      await trx.insertInto('programs').values({
        id: programId, athlete_id: athleteId, name: opts.name, description: null,
        start_date: opts.start, end_date: addDays(opts.start, 27), status: opts.status,
        created_at: now, updated_at: now, enabled_columns: null, focus: 'strength',
        export_layout: null, export_template_sha: null, builtin_template: 'coachboard',
      }).execute()
      for (let week = 0; week < 4; week++) {
        for (const [dayIndex, offset] of [[0, 0], [1, 2], [2, 4]] as const) {
          const date = addDays(opts.start, week * 7 + offset)
          const workoutId = uuidv4()
          await trx.insertInto('workouts').values({
            id: workoutId, program_id: programId, name: date, scheduled_date: date,
            completed_at: opts.done ? `${date}T18:00:00.000Z` : null, notes: null, created_at: now,
          }).execute()
          let order = 0
          for (const r of day(dayIndex, week)) {
            const weight = r.of ? plates(MAXES[r.of] * (r.pct! + opts.bump)) : r.weight ?? null
            await trx.insertInto('exercises').values({
              id: uuidv4(), workout_id: workoutId, name: r.name, sets: r.sets, reps: r.reps, weight,
              duration: null, distance: null, notes: null, order_index: order++, rest_time: null,
              intensity: r.of ? `${Math.round((r.pct! + opts.bump) * 100)}%` : null,
              // The athlete's results, on the finished block only.
              load_used: opts.done && weight != null ? String(weight) : null,
              rpe: opts.done && r.rpe ? r.rpe(week) : null,
              group_id: null,
              // The draft shows what a generated block looks like: notes on why.
              suggestion_note: !opts.done && r.name === 'Barbell Row'
                ? 'Engine-suggested accessory (upper back for the bench) — edit or remove'
                : null,
            }).execute()
          }
        }
      }
    }
    await block({ name: 'Strength Block 1', start: firstStart, status: 'completed', done: true, bump: 0 })
    await block({ name: 'Strength Block 2', start: nextStart, status: 'draft', done: false, bump: 0.025 })

    await trx.insertInto('payments').values({
      id: uuidv4(), athlete_id: athleteId, amount: 100, currency, start_date: thisMonday.slice(0, 8) + '01',
      paid_through: addDays(thisMonday, 27), paid: 1, paid_at: thisMonday, notes: 'Sample payment',
      created_at: now, updated_at: now,
    }).execute()
  })
  await addSampleLift(athleteId)
  log(`Sample athlete loaded (${athleteId})`)
  return sampleStatus()
}

/**
 * Remove the sample athlete and everything it owns. Programs, workouts,
 * exercises, maxes and payments go with the athlete (ON DELETE CASCADE);
 * saved analyses are only unlinked by that, so they are deleted first, and
 * their kept videos after the rows are gone (a locked file is left to the
 * launch sweep).
 */
export async function removeSampleAthlete(): Promise<SampleStatus> {
  const none: SampleStatus = { loaded: false, athleteId: null, analysisId: null }
  const { athleteId } = await sampleStatus()
  if (!athleteId) return none
  const videos = await getDb().selectFrom('video_analyses').select('video_path').where('athlete_id', '=', athleteId).execute()
  await getDb().transaction().execute(async (trx) => {
    await trx.deleteFrom('video_analyses').where('athlete_id', '=', athleteId).execute()
    await trx.deleteFrom('athletes').where('id', '=', athleteId).where('is_sample', '=', 1).execute()
  })
  for (const v of videos) await deleteVideo(v.video_path)
  log(`Sample athlete removed (${athleteId})`)
  return none
}
