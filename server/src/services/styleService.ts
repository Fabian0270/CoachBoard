import { getDb } from '../db.js'
import { findProgramForExport } from './programService.js'
import { buildWorkoutWeekMap, parseRpeFromIntensity } from './analysisService.js'
import { mainLiftKey, type MainLiftKey } from 'coachboard-shared/vbt'
import { STYLE_MIN_SAMPLE } from 'coachboard-shared'
import { PERIODIZATION_PATTERNS } from 'coachboard-shared'
import type {
  ProgramFingerprint,
  CoachStyleProfile,
  DetectedPattern,
  PeriodizationPatternId,
  SuggestionGoal,
  RepRangeBucket,
  RampDirection,
  VolumeDirection,
} from 'coachboard-shared'

// ---------------------------------------------------------------------------
// Coach-style learning (Feature 5a / 5b).
//
// A program "fingerprint" is a handful of structural signals derived from a
// program's workouts/exercises. The coach "style profile" is the rolling
// aggregate of those fingerprints across their completed/archived programs,
// optionally scoped to one training focus. Everything is computed on demand —
// the only persisted training-intent metadata is the program `focus` column —
// which keeps the math always-fresh and avoids a fingerprint cache to stale.
// ---------------------------------------------------------------------------

const num = (s: string | null): number | null => {
  if (!s) return null
  const n = parseFloat(s.replace(',', '.'))
  return isNaN(n) ? null : n
}

/** Lower bound of a reps cell ("5", "3-5", "3–5") as a number, or null. */
function repsLowerBound(reps: string | null): number | null {
  if (!reps) return null
  const m = reps.match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

function repBucket(reps: number): RepRangeBucket {
  if (reps <= 3) return '1-3'
  if (reps <= 6) return '4-6'
  if (reps <= 10) return '6-10'
  return '10+'
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function mode<T extends string>(xs: T[]): T | null {
  if (xs.length === 0) return null
  const counts = new Map<T, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best: T | null = null
  let bestN = -1
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n }
  }
  return best
}

/**
 * Classify a per-week numeric series as rising / flat / wave. An up-then-down (or
 * generally oscillating) series is a wave; otherwise the net change decides
 * rising vs flat. `eps` is the smallest week-to-week change considered real.
 */
function rampOf(weekValues: number[], eps: number): RampDirection {
  let vals = weekValues.filter((v) => !isNaN(v))
  // A final week that drops is a deload, not the start of a second wave. Read
  // as one, it turned every linear block that ended in a deload — the common
  // case — into "wave loading", and the pattern suggested from it was wrong.
  if (vals.length >= 3 && vals[vals.length - 1] < vals[vals.length - 2] - eps) {
    vals = vals.slice(0, -1)
  }
  if (vals.length < 2) return 'flat'
  let ups = 0
  let downs = 0
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1]
    if (d > eps) ups++
    else if (d < -eps) downs++
  }
  if (ups > 0 && downs > 0) return 'wave'
  const net = vals[vals.length - 1] - vals[0]
  if (net > eps) return 'rising'
  return 'flat'
}

type ExportData = NonNullable<Awaited<ReturnType<typeof findProgramForExport>>>

/** Derive the structural fingerprint of a single program from its export data. */
export function computeFingerprint(data: ExportData): ProgramFingerprint {
  const { program, workouts, exercises } = data
  const weekMap = buildWorkoutWeekMap(program, workouts)
  const weekOf = (workoutId: string): number => weekMap.get(workoutId)?.weekIndex ?? 0
  const dayOf = (workoutId: string): number => weekMap.get(workoutId)?.dayOfWeek ?? 0

  const weeks = new Set<number>()
  const repBuckets: RepRangeBucket[] = []
  const setsByWeek = new Map<number, number>()
  const rpeByWeek = new Map<number, number[]>()
  /** Competition-lift loads, by lift then week — see the intensity ramp below. */
  const loadsByLiftWeek = new Map<MainLiftKey, Map<number, number[]>>()
  const daysByWeek = new Map<number, Set<number>>()

  // ONE meaning of RPE per program: the prescribed target. A native program
  // writes the target into the intensity field ("RPE 8") and keeps `rpe` for
  // what the athlete reported; an imported sheet's RPE column lands in `rpe`
  // and IS the target. Reading `rpe` everywhere mixed the two, and the
  // "typical start and peak RPE" this produces are fed back into new drafts
  // as targets. So: intensity targets when the program has any, else `rpe`.
  const targetRpes = exercises.map((ex) => parseRpeFromIntensity(ex.intensity))
  const programHasTargets = targetRpes.some((r) => r !== null)

  for (const w of workouts) {
    const wk = weekOf(w.id)
    weeks.add(wk)
    if (!daysByWeek.has(wk)) daysByWeek.set(wk, new Set())
    daysByWeek.get(wk)!.add(dayOf(w.id))
  }

  exercises.forEach((ex, i) => {
    const wk = weekOf(ex.workout_id)
    weeks.add(wk)

    const reps = repsLowerBound(ex.reps)
    if (reps !== null) repBuckets.push(repBucket(reps))

    const sets = num(ex.sets)
    if (sets !== null) setsByWeek.set(wk, (setsByWeek.get(wk) ?? 0) + sets)

    const rpe = programHasTargets ? targetRpes[i] : num(ex.rpe)
    if (rpe !== null) {
      if (!rpeByWeek.has(wk)) rpeByWeek.set(wk, [])
      rpeByWeek.get(wk)!.push(rpe)
    }

    const lift = mainLiftKey(ex.name)
    // The coach's style is how they PRESCRIBE, so the Load Cap they wrote comes
    // first; what the athlete lifted stands in only where nothing was
    // prescribed (older imports, plain training logs).
    const load = ex.weight ?? num(ex.load_used)
    if (lift && load !== null) {
      const byWeek = loadsByLiftWeek.get(lift) ?? new Map<number, number[]>()
      loadsByLiftWeek.set(lift, byWeek)
      byWeek.set(wk, [...(byWeek.get(wk) ?? []), load])
    }
  })

  const sortedWeeks = [...weeks].sort((a, b) => a - b)
  const firstWeek = sortedWeeks[0] ?? 0
  const lastWeek = sortedWeeks[sortedWeeks.length - 1] ?? 0

  const avg = (xs: number[] | undefined): number | null =>
    xs && xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null

  const startRpe = avg(rpeByWeek.get(firstWeek))
  const peakRpe = avg(rpeByWeek.get(lastWeek))

  // Volume direction: total sets in the first vs final week (±5% dead-band).
  const firstSets = setsByWeek.get(firstWeek) ?? 0
  const lastSets = setsByWeek.get(lastWeek) ?? 0
  let volumeDirection: VolumeDirection = 'flat'
  if (lastSets > firstSets * 1.05) volumeDirection = 'rising'
  else if (lastSets < firstSets * 0.95) volumeDirection = 'tapering'

  // Intensity ramp from the COMPETITION lifts' loads, each relative to its own
  // first week, averaged across the lifts trained that week.
  //
  // This was the plain average of every logged load, accessories included —
  // so a week with curls logged in it read as a heavy dip, and squat rising
  // 100 -> 120 with curls in weeks 2 and 4 came out as "wave loading". And
  // averaging raw kilos across lifts moved with WHICH lifts were trained that
  // week. Falls back to RPE when no competition-lift loads were recorded —
  // common for prescribed-only historical sheets.
  const relativeByWeek = new Map<number, number[]>()
  for (const byWeek of loadsByLiftWeek.values()) {
    const firstWithLoad = sortedWeeks.find((wk) => byWeek.has(wk))
    const base = firstWithLoad === undefined ? null : avg(byWeek.get(firstWithLoad))
    if (!base) continue
    for (const [wk, loads] of byWeek) {
      relativeByWeek.set(wk, [...(relativeByWeek.get(wk) ?? []), avg(loads)! / base])
    }
  }
  const hasLoads = relativeByWeek.size > 0
  const intensitySeries = hasLoads
    ? sortedWeeks.map((wk) => {
        const ratios = relativeByWeek.get(wk)
        return ratios?.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : NaN
      })
    : sortedWeeks.map((wk) => avg(rpeByWeek.get(wk)) ?? NaN)
  // One percent of the lift's starting load, or a quarter of an RPE point.
  const intensityRamp = rampOf(intensitySeries, hasLoads ? 0.01 : 0.25)

  const dayCounts = sortedWeeks.map((wk) => daysByWeek.get(wk)?.size ?? 0).filter((n) => n > 0)
  const daysPerWeek = dayCounts.length
    ? Math.round((dayCounts.reduce((a, b) => a + b, 0) / dayCounts.length) * 10) / 10
    : 0

  return {
    programId: program.id,
    name: program.name,
    focus: (program.focus as SuggestionGoal | null) ?? null,
    blockWeeks: weeks.size,
    daysPerWeek,
    repRangeBucket: mode(repBuckets) ?? '4-6',
    startRpe,
    peakRpe,
    volumeDirection,
    intensityRamp,
  }
}

/** Round to the nearest 0.5 — RPE values are only ever programmed in half-points. */
const snapHalf = (n: number) => Math.round(n * 2) / 2

/**
 * Load the fingerprints of the coach's completed/archived programs, optionally
 * scoped to a single training focus. Shared by the style profile and pattern
 * detection so both see exactly the same program set.
 */
async function loadFingerprints(focus?: SuggestionGoal): Promise<ProgramFingerprint[]> {
  let query = getDb()
    .selectFrom('programs')
    .select(['id'])
    .where('status', 'in', ['completed', 'archived'])
  if (focus) query = query.where('focus', '=', focus)
  const rows = await query.execute()

  const fingerprints: ProgramFingerprint[] = []
  for (const { id } of rows) {
    const data = await findProgramForExport(id)
    if (data) fingerprints.push(computeFingerprint(data))
  }
  return fingerprints
}

/**
 * Aggregate the coach's completed/archived program fingerprints into one style
 * profile, optionally scoped to a single training focus. Below STYLE_MIN_SAMPLE
 * programs the profile is flagged `usable: false` and the learned fields are null
 * so the suggestion engine falls back to generic defaults.
 */
export async function computeStyleProfile(
  opts: { focus?: SuggestionGoal } = {},
): Promise<CoachStyleProfile> {
  const fingerprints = await loadFingerprints(opts.focus)

  const sampleSize = fingerprints.length
  const usable = sampleSize >= STYLE_MIN_SAMPLE
  const sourcePrograms = fingerprints.map((f) => ({ programId: f.programId, name: f.name }))

  if (!usable) {
    return {
      focus: opts.focus ?? null,
      sampleSize,
      usable: false,
      preferredBlockWeeks: null,
      preferredDaysPerWeek: null,
      preferredRepRange: null,
      typicalStartRpe: null,
      typicalPeakRpe: null,
      volumePattern: null,
      intensityPattern: null,
      sourcePrograms,
    }
  }

  const startRpes = fingerprints.map((f) => f.startRpe).filter((n): n is number => n !== null)
  const peakRpes = fingerprints.map((f) => f.peakRpe).filter((n): n is number => n !== null)

  return {
    focus: opts.focus ?? null,
    sampleSize,
    usable: true,
    preferredBlockWeeks: Math.round(median(fingerprints.map((f) => f.blockWeeks))),
    preferredDaysPerWeek: Math.round(median(fingerprints.map((f) => f.daysPerWeek))),
    preferredRepRange: mode(fingerprints.map((f) => f.repRangeBucket)),
    typicalStartRpe: startRpes.length ? snapHalf(median(startRpes)) : null,
    typicalPeakRpe: peakRpes.length ? snapHalf(median(peakRpes)) : null,
    volumePattern: mode(fingerprints.map((f) => f.volumeDirection)),
    intensityPattern: mode(fingerprints.map((f) => f.intensityRamp)),
    sourcePrograms,
  }
}

// ---------------------------------------------------------------------------
// Periodization pattern detection (Feature 5d)
// ---------------------------------------------------------------------------

/** RPE within half a point of 8 — the hallmark of a repeated-effort block. */
const aroundRpe8 = (rpe: number | null): boolean => rpe !== null && rpe >= 7.5 && rpe <= 8.5

/**
 * Classify a single fingerprint into at most one named pattern. Order matters:
 * the more specific intensity/volume shapes are tested first so a program can't
 * fall into two buckets at once.
 */
function classifyPattern(fp: ProgramFingerprint): PeriodizationPatternId | null {
  // Rep range "3–6" spans the 1-3 and 4-6 buckets.
  const repsLow = fp.repRangeBucket === '1-3' || fp.repRangeBucket === '4-6'

  if (fp.intensityRamp === 'wave') return 'wave_loading'
  if (fp.intensityRamp === 'rising' && fp.volumeDirection === 'tapering') return 'accumulation_intensification'
  if (fp.intensityRamp === 'rising' && fp.volumeDirection === 'flat' && repsLow) return 'linear_progression'
  if (
    fp.intensityRamp === 'flat' &&
    fp.volumeDirection === 'flat' &&
    aroundRpe8(fp.startRpe) &&
    aroundRpe8(fp.peakRpe)
  ) {
    return 'repeated_effort'
  }
  return null
}

/**
 * Group the coach's completed/archived programs by the periodization pattern
 * each one exhibits and return the patterns matched by ≥ STYLE_MIN_SAMPLE
 * programs, each carrying the coach's own typical parameters for that pattern.
 * Detection spans all focuses — a pattern carries its own goal/template.
 */
export async function detectPatterns(): Promise<DetectedPattern[]> {
  const fingerprints = await loadFingerprints()

  const byPattern = new Map<PeriodizationPatternId, ProgramFingerprint[]>()
  for (const fp of fingerprints) {
    const id = classifyPattern(fp)
    if (!id) continue
    if (!byPattern.has(id)) byPattern.set(id, [])
    byPattern.get(id)!.push(fp)
  }

  const result: DetectedPattern[] = []
  for (const info of PERIODIZATION_PATTERNS) {
    const fps = byPattern.get(info.id)
    if (!fps || fps.length < STYLE_MIN_SAMPLE) continue

    const startRpes = fps.map((f) => f.startRpe).filter((n): n is number => n !== null)
    const peakRpes = fps.map((f) => f.peakRpe).filter((n): n is number => n !== null)

    result.push({
      ...info,
      sampleSize: fps.length,
      preferredBlockWeeks: Math.round(median(fps.map((f) => f.blockWeeks))),
      preferredDaysPerWeek: Math.round(median(fps.map((f) => f.daysPerWeek))),
      preferredRepRange: mode(fps.map((f) => f.repRangeBucket)),
      typicalStartRpe: startRpes.length ? snapHalf(median(startRpes)) : null,
      typicalPeakRpe: peakRpes.length ? snapHalf(median(peakRpes)) : null,
      sourcePrograms: fps.map((f) => ({ programId: f.programId, name: f.name })),
    })
  }
  return result
}
