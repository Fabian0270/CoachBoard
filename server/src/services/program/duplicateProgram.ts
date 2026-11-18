import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db.js'
import { bestStoredMax, mainLiftKey, type MainLiftKey } from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// Duplicate a program: the same block for another athlete, another start date,
// or as a template with no athlete at all.
//
// Everything about the block comes along — days, exercises, set rows, notes,
// columns, focus, the Excel look — moved so it starts on the new Monday. What
// the athlete logged (Load Used, Last Set RPE) comes along only when asked.
//
// Loads can be scaled to the new athlete: a Load Cap on a competition lift is
// multiplied by new max / old max, rounded to 2.5 kg, when both athletes have
// a max for that lift. Anything without both maxes keeps its number, and the
// result says how many were scaled, so nothing is changed silently.
// ---------------------------------------------------------------------------

export interface DuplicateOptions {
  /** null = no athlete: kept as a template. */
  athleteId: string | null
  name: string
  /** Any day of the week the copy should start in; it starts on that Monday. */
  startDate: string
  keepResults: boolean
  scaleLoads: boolean
}

export interface DuplicateResult {
  id: string
  /** Load Caps changed by scaling. */
  scaled: number
  /** Load Caps on main lifts left as they were, for want of a max on one side. */
  notScaled: number
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const monday = (d: Date) => {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() - ((r.getUTCDay() + 6) % 7))
  return r
}

async function maxesByLift(athleteId: string | null): Promise<Map<MainLiftKey, number>> {
  const out = new Map<MainLiftKey, number>()
  if (!athleteId) return out
  const rows = await getDb().selectFrom('athlete_maxes').selectAll().where('athlete_id', '=', athleteId).execute()
  for (const key of ['squat', 'bench', 'deadlift'] as MainLiftKey[]) {
    const best = bestStoredMax(key, rows)
    if (best) out.set(key, best.weight)
  }
  return out
}

/** Returns null when the source program does not exist. */
export async function duplicateProgram(sourceId: string, opts: DuplicateOptions): Promise<DuplicateResult | null> {
  const db = getDb()
  const source = await db.selectFrom('programs').selectAll().where('id', '=', sourceId).executeTakeFirst()
  if (!source) return null

  const newStart = monday(parse(opts.startDate))
  const oldStart = source.start_date ? monday(parse(source.start_date)) : newStart
  const shiftDays = Math.round((newStart.getTime() - oldStart.getTime()) / 86_400_000)
  const shift = (date: string | null) => {
    if (!date) return null
    const d = parse(date)
    d.setUTCDate(d.getUTCDate() + shiftDays)
    return iso(d)
  }
  const weeks = source.start_date && source.end_date
    ? Math.max(1, Math.round((parse(source.end_date).getTime() - oldStart.getTime()) / (7 * 86_400_000)))
    : 4
  const newEnd = new Date(newStart)
  newEnd.setUTCDate(newEnd.getUTCDate() + weeks * 7 - 1)

  const scaleFrom = opts.scaleLoads ? await maxesByLift(source.athlete_id) : new Map<MainLiftKey, number>()
  const scaleTo = opts.scaleLoads ? await maxesByLift(opts.athleteId) : new Map<MainLiftKey, number>()

  const workouts = await db.selectFrom('workouts').selectAll().where('program_id', '=', sourceId).execute()
  const exercises = workouts.length
    ? await db.selectFrom('exercises').selectAll().where('workout_id', 'in', workouts.map((w) => w.id)).orderBy('order_index').execute()
    : []

  const id = uuidv4()
  const now = new Date().toISOString()
  let scaled = 0
  let notScaled = 0

  await db.transaction().execute(async (trx) => {
    await trx.insertInto('programs').values({
      id,
      athlete_id: opts.athleteId,
      name: opts.name,
      description: source.description,
      start_date: iso(newStart),
      end_date: iso(newEnd),
      status: 'active',
      created_at: now,
      updated_at: now,
      enabled_columns: source.enabled_columns,
      focus: source.focus,
      export_layout: source.export_layout,
      // The workbook is shared by its key, never copied.
      export_template_sha: source.export_template_sha,
      builtin_template: source.builtin_template,
    }).execute()

    const groupIds = new Map<string, string>()
    for (const w of workouts) {
      const newWorkoutId = uuidv4()
      const date = shift(w.scheduled_date)
      await trx.insertInto('workouts').values({
        id: newWorkoutId,
        program_id: id,
        // A day named after its date follows its date.
        name: w.name === w.scheduled_date && date ? date : w.name,
        scheduled_date: date,
        completed_at: null,
        notes: w.notes,
        created_at: now,
      }).execute()

      for (const ex of exercises.filter((e) => e.workout_id === w.id)) {
        let weight = ex.weight
        const key = weight != null && opts.scaleLoads ? mainLiftKey(ex.name) : null
        if (key && weight != null) {
          const from = scaleFrom.get(key)
          const to = scaleTo.get(key)
          if (from && to) {
            const next = Math.round((weight * to) / from / 2.5) * 2.5
            if (next !== weight) scaled++
            weight = next
          } else {
            notScaled++
          }
        }
        let groupId: string | null = null
        if (ex.group_id) {
          if (!groupIds.has(ex.group_id)) groupIds.set(ex.group_id, uuidv4())
          groupId = groupIds.get(ex.group_id)!
        }
        await trx.insertInto('exercises').values({
          id: uuidv4(),
          workout_id: newWorkoutId,
          name: ex.name,
          sets: ex.sets,
          reps: ex.reps,
          weight,
          duration: ex.duration,
          distance: ex.distance,
          notes: ex.notes,
          order_index: ex.order_index,
          rest_time: ex.rest_time,
          intensity: ex.intensity,
          load_used: opts.keepResults ? ex.load_used : null,
          rpe: opts.keepResults ? ex.rpe : null,
          reps_done: opts.keepResults ? ex.reps_done : null,
          velocity: ex.velocity,
          group_id: groupId,
          suggestion_note: ex.suggestion_note,
        }).execute()
      }
    }
  })

  return { id, scaled, notScaled }
}
