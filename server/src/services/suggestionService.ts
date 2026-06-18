import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { getProgramReport } from './analysisService.js'
import { findProgramById } from './programService.js'
import { findTemplate } from '../lib/suggestionTemplates.js'
import { SUGGESTION_TEMPLATES } from 'coachboard-shared'
import type { SuggestProgramBody, SuggestProgramResult, WeekSlot } from 'coachboard-shared'

const MAIN_LIFT_KEYWORDS = ['squat', 'bench', 'deadlift'] as const
type LiftKey = (typeof MAIN_LIFT_KEYWORDS)[number]

// Day-of-week offsets (0 = Monday) and lift assignments per training-day count.
const DAY_OFFSETS: Record<number, number[]> = {
  3: [0, 2, 4],     // Mon, Wed, Fri
  4: [0, 1, 3, 4],  // Mon, Tue, Thu, Fri
  5: [0, 1, 2, 3, 4],
}
const LIFT_ORDER: Record<number, (LiftKey | null)[]> = {
  3: ['squat', 'bench', 'deadlift'],
  4: ['squat', 'bench', 'deadlift', 'bench'],
  5: ['squat', 'bench', 'deadlift', 'bench', 'squat'],
}
const LIFT_DISPLAY: Record<LiftKey, string> = {
  squat: 'Squat',
  bench: 'Bench Press',
  deadlift: 'Deadlift',
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function liftKeyFor(name: string): LiftKey | null {
  const lower = name.toLowerCase()
  for (const k of MAIN_LIFT_KEYWORDS) {
    if (lower.includes(k)) return k
  }
  return null
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return toIso(date)
}

type AccessoryRow = {
  name: string
  sets: string | null
  reps: string | null
  weight: number | null
  duration: number | null
  distance: number | null
  notes: string | null
  rest_time: string | null
  intensity: string | null
}

// For each main lift, collect the accessories from its day in the source program's
// last week. Later bench / squat days overwrite earlier ones — last occurrence wins.
function accessoriesByLift(
  workouts: Array<{
    scheduled_date: string | null
    exercises: Array<{
      name: string
      sets: string | null
      reps: string | null
      weight: number | null
      duration: number | null
      distance: number | null
      notes: string | null
      rest_time: string | null
      intensity: string | null
    }>
  }>,
): Map<LiftKey, AccessoryRow[]> {
  const withDates = workouts.filter((w) => w.scheduled_date).sort((a, b) =>
    a.scheduled_date! < b.scheduled_date! ? -1 : 1,
  )
  if (withDates.length === 0) return new Map()

  const lastDate = withDates[withDates.length - 1].scheduled_date!
  const [ly, lm, ld] = lastDate.split('-').map(Number)
  const cutoff = toIso(new Date(Date.UTC(ly, lm - 1, ld - 6)))
  const lastWeek = withDates.filter((w) => w.scheduled_date! >= cutoff)

  const result = new Map<LiftKey, AccessoryRow[]>()

  for (const workout of lastWeek) {
    let mainLift: LiftKey | null = null
    const accessories: AccessoryRow[] = []

    for (const ex of workout.exercises) {
      const key = liftKeyFor(ex.name)
      if (key && !mainLift) {
        mainLift = key
      } else {
        accessories.push({
          name: ex.name,
          sets: ex.sets,
          reps: ex.reps,
          weight: ex.weight,
          duration: ex.duration,
          distance: ex.distance,
          notes: ex.notes,
          rest_time: ex.rest_time,
          intensity: ex.intensity,
        })
      }
    }

    if (mainLift) result.set(mainLift, accessories)
  }

  return result
}

export async function generateDraftProgram(
  sourceProgramId: string,
  body: SuggestProgramBody,
): Promise<SuggestProgramResult> {
  const source = await findProgramById(sourceProgramId)
  if (!source) throw new Error(`Program not found: ${sourceProgramId}`)
  // A finished program (completed OR an imported archived back-catalogue program)
  // supplies the e1RM, RPE-deviation adjustment and accessories for the new block.
  if (source.status !== 'completed' && source.status !== 'archived') {
    throw new Error('Source program must be completed or archived')
  }

  const report = await getProgramReport(sourceProgramId)
  if (!report) throw new Error(`Could not compute report for program ${sourceProgramId}`)

  // Build e1RM map: program report first, athlete stored maxes as fallback.
  const e1rmMap = new Map<LiftKey, number>()
  for (const trend of report.e1rmTrends) {
    if (trend.latestE1RM !== null) {
      e1rmMap.set(trend.liftKey as LiftKey, trend.latestE1RM)
    }
  }
  for (const max of report.storedMaxes) {
    const key = liftKeyFor(max.lift_name)
    if (key && !e1rmMap.has(key)) e1rmMap.set(key, max.weight)
  }

  // Positive deviation = athlete worked harder than planned → ease off next block.
  const rpeAdjustment = clamp((report.avgRpeDeviation ?? 0) * 0.05, -0.05, 0.05)

  const template = findTemplate(body.templateId)
  if (!template) throw new Error(`Unknown template: ${body.templateId}`)

  const slotsByLift = new Map<LiftKey, WeekSlot[]>()
  for (const [liftKey, e1rm] of e1rmMap) {
    slotsByLift.set(liftKey, template.generate(body.weeks, e1rm, rpeAdjustment, body.style))
  }

  // Tag the draft with the template's goal so it, too, feeds the style profile.
  const draftFocus = SUGGESTION_TEMPLATES.find((t) => t.id === body.templateId)?.goal ?? null

  // Suffix appended to each main-lift note when style nudges were applied, so the
  // engine stays auditable (the coach sees exactly what their profile changed).
  const styleNote = body.style
    ? ' · ' + [
        body.style.startRpe !== undefined ? `start RPE ${body.style.startRpe}` : null,
        body.style.peakRpe !== undefined ? `peak RPE ${body.style.peakRpe}` : null,
        body.style.repBias ? `${body.style.repBias > 0 ? '+' : ''}${body.style.repBias} reps` : null,
      ].filter(Boolean).join(', ') + ' from your style'
    : ''

  const accByLift = accessoriesByLift(source.workouts ?? [])

  const dayOffsets = DAY_OFFSETS[body.trainingDaysPerWeek] ?? DAY_OFFSETS[3]
  const liftOrder = LIFT_ORDER[body.trainingDaysPerWeek] ?? LIFT_ORDER[3]

  const db = getDb()
  const now = new Date().toISOString()
  const startIso = body.startDate
  const endIso = addDays(startIso, body.weeks * 7 - 1)

  const draftProgram = await db
    .insertInto('programs')
    .values({
      id: uuidv4(),
      athlete_id: body.athleteId,
      name: `[Draft] ${source.name}`,
      description: null,
      start_date: startIso,
      end_date: endIso,
      status: 'draft',
      enabled_columns: source.enabled_columns ? JSON.stringify(source.enabled_columns) : null,
      focus: draftFocus,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  for (let week = 1; week <= body.weeks; week++) {
    for (let dayIdx = 0; dayIdx < body.trainingDaysPerWeek; dayIdx++) {
      const workoutDate = addDays(startIso, (week - 1) * 7 + dayOffsets[dayIdx])
      const liftKey = liftOrder[dayIdx]
      const slot = liftKey ? (slotsByLift.get(liftKey)?.[week - 1] ?? null) : null
      const accessories = (liftKey ? accByLift.get(liftKey) : undefined) ?? []

      const workout = await db
        .insertInto('workouts')
        .values({
          id: uuidv4(),
          program_id: draftProgram.id,
          name: workoutDate,
          scheduled_date: workoutDate,
          notes: null,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      let orderIndex = 0

      if (slot && liftKey) {
        await db
          .insertInto('exercises')
          .values({
            id: uuidv4(),
            workout_id: workout.id,
            name: LIFT_DISPLAY[liftKey],
            sets: String(slot.sets),
            reps: String(slot.reps),
            weight: slot.weight,
            duration: null,
            distance: null,
            notes: null,
            order_index: orderIndex++,
            rest_time: null,
            intensity: `RPE ${slot.targetRpe}`,
            load_used: null,
            rpe: null,
            group_id: null,
            suggestion_note: slot.explanation + styleNote,
          })
          .execute()
      }

      for (const acc of accessories) {
        await db
          .insertInto('exercises')
          .values({
            id: uuidv4(),
            workout_id: workout.id,
            name: acc.name,
            sets: acc.sets,
            reps: acc.reps,
            weight: acc.weight,
            duration: acc.duration,
            distance: acc.distance,
            notes: acc.notes,
            order_index: orderIndex++,
            rest_time: acc.rest_time,
            intensity: acc.intensity,
            load_used: null,
            rpe: null,
            group_id: null,
            suggestion_note: null,
          })
          .execute()
      }
    }
  }

  return { draftProgramId: draftProgram.id }
}
