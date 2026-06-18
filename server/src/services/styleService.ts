import { getDb } from '../db.js'
import { findProgramForExport } from './programService.js'
import { buildWorkoutWeekMap } from './analysisService.js'
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
  const vals = weekValues.filter((v) => !isNaN(v))
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
  const loadByWeek = new Map<number, number[]>()
  const daysByWeek = new Map<number, Set<number>>()

  for (const w of workouts) {
    const wk = weekOf(w.id)
    weeks.add(wk)
    if (!daysByWeek.has(wk)) daysByWeek.set(wk, new Set())
    daysByWeek.get(wk)!.add(dayOf(w.id))
  }

  for (const ex of exercises) {
    const wk = weekOf(ex.workout_id)
    weeks.add(wk)

    const reps = repsLowerBound(ex.reps)
    if (reps !== null) repBuckets.push(repBucket(reps))

    const sets = num(ex.sets)
    if (sets !== null) setsByWeek.set(wk, (setsByWeek.get(wk) ?? 0) + sets)

    const rpe = num(ex.rpe)
    if (rpe !== null) {
      if (!rpeByWeek.has(wk)) rpeByWeek.set(wk, [])
      rpeByWeek.get(wk)!.push(rpe)
    }

    const load = num(ex.load_used)
    if (load !== null) {
      if (!loadByWeek.has(wk)) loadByWeek.set(wk, [])
      loadByWeek.get(wk)!.push(load)
    }
  }

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

  // Intensity ramp from per-week average load (fall back to per-week average RPE
  // when no loads were recorded — common for prescribed-only historical sheets).
  const weekLoadSeries = sortedWeeks.map((wk) => avg(loadByWeek.get(wk)) ?? NaN)
  const hasLoads = weekLoadSeries.some((v) => !isNaN(v))
  const intensitySeries = hasLoads
    ? weekLoadSeries
    : sortedWeeks.map((wk) => avg(rpeByWeek.get(wk)) ?? NaN)
  const intensityRamp = rampOf(intensitySeries, hasLoads ? 1 : 0.25)

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
