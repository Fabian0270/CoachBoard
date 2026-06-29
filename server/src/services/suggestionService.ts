import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { getProgramReport, buildWorkoutWeekMap } from './analysisService.js'
import { findProgramById } from './programService.js'
import { findTemplate } from '../lib/suggestionTemplates.js'
import { SUGGESTION_TEMPLATES } from 'coachboard-shared'
import { ACCESSORY_POOLS } from 'coachboard-shared/knowledge'
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

// Latest stored 1RM per main lift for an athlete, keyed by lift. Used to scale a
// draft's loads to the athlete it's being generated for — essential when the
// source program belongs to a different athlete.
async function storedMaxE1rmMap(athleteId: string): Promise<Map<LiftKey, number>> {
  const rows = await getDb()
    .selectFrom('athlete_maxes')
    .selectAll()
    .where('athlete_id', '=', athleteId)
    .orderBy('lift_name', 'asc')
    .orderBy('recorded_at', 'desc')
    .execute()
  const map = new Map<LiftKey, number>()
  for (const m of rows) {
    const key = liftKeyFor(m.lift_name)
    if (key && !map.has(key)) map.set(key, m.weight) // most-recent row per lift wins
  }
  return map
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

// A carried-over accessory keeps only its movement scaffold. The stale `weight`
// and `intensity`/RPE from the previous block are deliberately dropped — they have
// no e1RM to recompute against and would contradict the freshly generated arc.
type AccessoryRow = {
  name: string
  sets: string | null
  reps: string | null
  duration: number | null
  distance: number | null
  notes: string | null
  rest_time: string | null
  // Set only on knowledge-base gap-fill suggestions (Feature: smart accessories).
  // Carried-over accessories leave this undefined → stored as null, so the coach
  // can tell their own choices apart from engine suggestions.
  suggestionNote?: string | null
}

type SourceExercise = {
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
type SourceWorkout = { id: string; scheduled_date: string | null; exercises: SourceExercise[] }

// One main lift plus the accessories trained alongside it on a given day.
type LiftSegment = { liftKey: LiftKey; accessories: AccessoryRow[] }
// A training day in the new block: its offset from the block's Monday and the
// ordered lifts it contains (more than one ⇒ a full-body / SBD day).
type DayLayout = { dayOffset: number; lifts: LiftSegment[] }

const toAccessoryRow = (ex: SourceExercise): AccessoryRow => ({
  name: ex.name,
  sets: ex.sets,
  reps: ex.reps,
  duration: ex.duration,
  distance: ex.distance,
  notes: ex.notes,
  rest_time: ex.rest_time,
})

/**
 * Mirror the source program's last-week layout: one DayLayout per training day,
 * each carrying the lifts trained that day (preserving full-body/SBD days) with
 * accessories attached to their nearest preceding main lift. A repeated keyword
 * on the same day (e.g. "Comp Bench" after "Bench Press") folds into the existing
 * segment rather than spawning a second, contradictory prescription.
 * Returns null when there are no dated workouts or no main lifts to anchor on.
 */
function deriveSourceLayout(source: { start_date: string | null; workouts: SourceWorkout[] }): DayLayout[] | null {
  const workouts = source.workouts ?? []
  const weekMap = buildWorkoutWeekMap({ start_date: source.start_date }, workouts)
  const located = workouts
    .map((w) => ({ w, loc: weekMap.get(w.id) }))
    .filter((x): x is { w: SourceWorkout; loc: { weekIndex: number; dayOfWeek: number } } => !!x.loc)
  if (located.length === 0) return null

  const lastWeek = Math.max(...located.map((x) => x.loc.weekIndex))
  const lastWeekDays = located
    .filter((x) => x.loc.weekIndex === lastWeek)
    .sort((a, b) => a.loc.dayOfWeek - b.loc.dayOfWeek)

  const days: DayLayout[] = []
  for (const { w, loc } of lastWeekDays) {
    const lifts: LiftSegment[] = []
    let current: LiftSegment | null = null
    const pending: AccessoryRow[] = []  // accessories seen before the day's first lift

    for (const ex of w.exercises) {
      const key = liftKeyFor(ex.name)
      if (key) {
        let seg = lifts.find((l) => l.liftKey === key)
        if (!seg) {
          seg = { liftKey: key, accessories: pending.splice(0) }
          lifts.push(seg)
        }
        current = seg
        continue
      }
      const row = toAccessoryRow(ex)
      if (current) current.accessories.push(row)
      else pending.push(row)
    }

    if (lifts.length === 0) continue  // accessory-only day: no e1RM slot to anchor it
    days.push({ dayOffset: loc.dayOfWeek, lifts })
  }

  return days.length ? days : null
}

/**
 * Generic one-lift-per-day split keyed by training-day count — the classic
 * Mon/Wed/Fri-style layout. Accessories come from each lift's day in the source's
 * last week (last occurrence wins, see `accessoriesByLift`).
 */
function genericLayout(source: { workouts: SourceWorkout[] }, daysPerWeek: number): DayLayout[] {
  const accByLift = accessoriesByLift(source.workouts ?? [])
  const offsets = DAY_OFFSETS[daysPerWeek] ?? DAY_OFFSETS[3]
  const order = LIFT_ORDER[daysPerWeek] ?? LIFT_ORDER[3]
  return offsets.map((dayOffset, i) => {
    const liftKey = order[i]
    return { dayOffset, lifts: liftKey ? [{ liftKey, accessories: accByLift.get(liftKey) ?? [] }] : [] }
  })
}

// For each main lift, collect the accessories from its day in the source program's
// last week. Later bench / squat days overwrite earlier ones — last occurrence wins.
function accessoriesByLift(workouts: SourceWorkout[]): Map<LiftKey, AccessoryRow[]> {
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
      if (key) {
        // A main lift or a variation of one (e.g. "Comp Bench"). The first match
        // is the day's main lift; any further keyword matches fold into it rather
        // than becoming a second, contradictory prescription.
        if (!mainLift) mainLift = key
        continue
      }
      accessories.push(toAccessoryRow(ex))
    }

    if (mainLift) result.set(mainLift, accessories)
  }

  return result
}

// Number of weak-point accessories suggested for a main lift with an empty day.
const GAP_FILL_ACCESSORY_COUNT = 3

/**
 * Knowledge-base accessory suggestions for a main lift, used ONLY to fill a gap
 * (a main lift whose day carries no accessories). Per the shared/knowledge.ts
 * "support, never override" contract these are tier-3: they never replace a
 * coach's carried-over accessories. Each is tagged via suggestionNote so the
 * coach can see and edit it. Picks are deterministic (first N of the pool).
 */
function suggestedAccessories(liftKey: LiftKey): AccessoryRow[] {
  const pool = ACCESSORY_POOLS[liftKey] ?? []
  return pool.slice(0, GAP_FILL_ACCESSORY_COUNT).map((a) => ({
    name: a.name,
    sets: '3',
    reps: `${a.repRange[0]}-${a.repRange[1]}`,
    duration: null,
    distance: null,
    notes: null,
    rest_time: null,
    suggestionNote: `Engine-suggested accessory (${a.addresses}) — edit or remove`,
  }))
}

/**
 * Opt-in gap fill: for any main lift whose day has no accessories, attach
 * weak-point suggestions from the knowledge base. Lifts that already carry
 * accessories (the coach's own, mirrored from the source) are left untouched.
 */
function enrichLayout(layout: DayLayout[]): DayLayout[] {
  return layout.map((day) => ({
    ...day,
    lifts: day.lifts.map((seg) =>
      seg.accessories.length === 0
        ? { ...seg, accessories: suggestedAccessories(seg.liftKey) }
        : seg,
    ),
  }))
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

  const template = findTemplate(body.templateId)
  if (!template) throw new Error(`Unknown template: ${body.templateId}`)

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

  // Mirror the source program's weekly structure by default (preserving full-body
  // SBD days); fall back to the generic split when the coach overrides or the
  // source has no derivable layout.
  const baseLayout =
    body.layout === 'split'
      ? genericLayout(source, body.trainingDaysPerWeek)
      : deriveSourceLayout(source) ?? genericLayout(source, body.trainingDaysPerWeek)

  // Opt-in: fill main lifts that have no accessories with knowledge-base
  // suggestions. Default off → behaviour unchanged. Never touches carried-over
  // accessories (see shared/knowledge.ts contract).
  const layout = body.enrichAccessories ? enrichLayout(baseLayout) : baseLayout

  // Generating for a *different* athlete than the source program belongs to — e.g.
  // a brand-new athlete with no programs of their own reusing another athlete's
  // block. The new athlete's own maxes must drive the loads (never the source
  // athlete's), and the source athlete's RPE deviation must not nudge them.
  const crossAthlete = source.athlete_id !== body.athleteId

  // Build the e1RM map that scales each main lift's loads.
  const e1rmMap = new Map<LiftKey, number>()
  if (crossAthlete) {
    for (const [key, weight] of await storedMaxE1rmMap(body.athleteId)) e1rmMap.set(key, weight)
  } else {
    // Same athlete: the finished program's measured e1RM, with their stored maxes
    // as a fallback for lifts that lack a usable in-program estimate.
    for (const trend of report.e1rmTrends) {
      if (trend.latestE1RM !== null) e1rmMap.set(trend.liftKey as LiftKey, trend.latestE1RM)
    }
    for (const max of report.storedMaxes) {
      const key = liftKeyFor(max.lift_name)
      if (key && !e1rmMap.has(key)) e1rmMap.set(key, max.weight)
    }
  }

  // Cross-athlete with no recorded max for a lift in the layout: still scaffold the
  // main lift (sets/reps/RPE from the template) but leave the weight blank for the
  // coach to fill, rather than borrowing the source athlete's load.
  const blankWeightLifts = new Set<LiftKey>()
  if (crossAthlete) {
    for (const day of layout) {
      for (const seg of day.lifts) {
        if (!e1rmMap.has(seg.liftKey)) {
          e1rmMap.set(seg.liftKey, 0)
          blankWeightLifts.add(seg.liftKey)
        }
      }
    }
  }

  // Positive deviation = athlete worked harder than planned → ease off next block.
  const rpeAdjustment = crossAthlete
    ? 0
    : clamp((report.avgRpeDeviation ?? 0) * 0.05, -0.05, 0.05)

  const slotsByLift = new Map<LiftKey, WeekSlot[]>()
  for (const [liftKey, e1rm] of e1rmMap) {
    slotsByLift.set(liftKey, template.generate(body.weeks, e1rm, rpeAdjustment, body.style))
  }

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
      // Carry the source's captured Excel layout + original file so the draft
      // exports in the coach's own style (Feature: export style templates).
      export_layout: source.export_layout ? JSON.stringify(source.export_layout) : null,
      export_template_xlsx: source.export_template_xlsx ?? null,
      // Override > inherit the source's built-in look > CoachBoard default. (Moot
      // when the draft inherits an imported coach style, which wins at export.)
      builtin_template: body.builtin_template ?? source.builtin_template ?? 'coachboard',
      focus: draftFocus,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  for (let week = 1; week <= body.weeks; week++) {
    for (const day of layout) {
      const workoutDate = addDays(startIso, (week - 1) * 7 + day.dayOffset)

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

      for (const seg of day.lifts) {
        const slot = slotsByLift.get(seg.liftKey)?.[week - 1] ?? null

        if (slot) {
          await db
            .insertInto('exercises')
            .values({
              id: uuidv4(),
              workout_id: workout.id,
              name: LIFT_DISPLAY[seg.liftKey],
              sets: String(slot.sets),
              reps: String(slot.reps),
              weight: blankWeightLifts.has(seg.liftKey) ? null : slot.weight,
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

        for (const acc of seg.accessories) {
          await db
            .insertInto('exercises')
            .values({
              id: uuidv4(),
              workout_id: workout.id,
              name: acc.name,
              sets: acc.sets,
              reps: acc.reps,
              weight: null,
              duration: acc.duration,
              distance: acc.distance,
              notes: acc.notes,
              order_index: orderIndex++,
              rest_time: acc.rest_time,
              intensity: null,
              load_used: null,
              rpe: null,
              group_id: null,
              suggestion_note: acc.suggestionNote ?? null,
            })
            .execute()
        }
      }
    }
  }

  return { draftProgramId: draftProgram.id }
}
