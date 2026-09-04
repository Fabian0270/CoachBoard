// ---------------------------------------------------------------------------
// Velocity-based training reference data + math.
//
// The bar-path tracker (shared/videoAnalysis.ts) produces velocities. This
// module is what turns those numbers into something a coach can act on: roughly
// what RPE a set was, whether that matches what the athlete called, and — across
// several loads — a load-velocity profile with an estimated 1RM.
//
// Same "math as data" shape as shared/rpe.ts: pure functions and constants, no
// I/O and no DOM, so every number here is testable under the client's node-only
// test runner.
//
// ---------------------------------------------------------------------------
// SOURCING
// ---------------------------------------------------------------------------
// LRV_ANCHORS and the last-rep-velocity concept:
//   https://vbtcoach.com/blog/last-rep-velocity-and-rpe
// The linear "slope per RPE point" model behind lrvChart():
//   https://vbtcoach.com/calculators/rpe-last-rep-velocity-converter
// MVT_RANGE, the regression-to-1RM method and its caveats:
//   https://vbtcoach.com/calculators/load-velocity-profile-chart
// VELOCITY_ZONES comes from NEITHER — see the comment on that block.
//
// These are population values for intermediate+ lifters of average height. They
// are a starting point the coach replaces with the athlete's own measurements,
// which is exactly what the `anchors` parameters throughout this file are for.
// ---------------------------------------------------------------------------

import { RPE_VALUES } from './rpe.js'
import type { RepMetrics } from './videoAnalysis.js'

// ---------------------------------------------------------------------------
// 1. Lift identity
// ---------------------------------------------------------------------------
// Deliberately NOT knowledge.ts's `MainLift`. VBT numbers differ sharply between
// sumo and conventional and between bar types, so a type that collapses them all
// to 'deadlift' cannot carry this data.

export type VbtLift =
  | 'back-squat'
  | 'front-squat'
  | 'bench-press'
  | 'deadlift-conventional'
  | 'deadlift-sumo'
  | 'deadlift-trapbar'
  | 'barbell-row'
  | 'overhead-press'
  | 'other'

export const VBT_LIFTS: { id: VbtLift; label: string }[] = [
  { id: 'back-squat', label: 'Back squat' },
  { id: 'front-squat', label: 'Front squat' },
  { id: 'bench-press', label: 'Bench press' },
  { id: 'deadlift-conventional', label: 'Deadlift — conventional' },
  { id: 'deadlift-sumo', label: 'Deadlift — sumo' },
  { id: 'deadlift-trapbar', label: 'Deadlift — trap bar' },
  { id: 'barbell-row', label: 'Barbell row' },
  { id: 'overhead-press', label: 'Overhead press' },
  { id: 'other', label: 'Other' },
]

const LIFT_IDS = new Set<string>(VBT_LIFTS.map((l) => l.id))

/** Narrows a stored string back to a lift, so a hand-edited database cannot poison the charts. */
export function isVbtLift(value: unknown): value is VbtLift {
  return typeof value === 'string' && LIFT_IDS.has(value)
}

export function liftLabel(lift: VbtLift): string {
  return VBT_LIFTS.find((l) => l.id === lift)?.label ?? 'Other'
}

// ---------------------------------------------------------------------------
// 2. Published reference data
// ---------------------------------------------------------------------------

export interface LrvAnchor {
  rpe: number
  /** Mean concentric velocity of the last rep, m/s. */
  velocity: number
}

/**
 * Last-rep velocity at three efforts per lift: max out (RPE 10), tough (8.5),
 * moderate (7).
 *
 * `overhead-press` and `other` are absent on purpose rather than guessed at —
 * the source publishes a minimum velocity threshold for the press but no LRV
 * table, and there is no sane default for "other". Consumers get null and are
 * expected to say so instead of drawing a fabricated chart.
 *
 * Note a disagreement between the two sources on back squat at RPE 10: the
 * article's table says 0.25 m/s, while the converter's worked example uses
 * ~0.30. The article wins here because it is the per-lift table and covers every
 * lift; the converter's figure is one illustrative example.
 */
export const LRV_ANCHORS: Partial<Record<VbtLift, LrvAnchor[]>> = {
  'back-squat': [{ rpe: 10, velocity: 0.25 }, { rpe: 8.5, velocity: 0.35 }, { rpe: 7, velocity: 0.45 }],
  'front-squat': [{ rpe: 10, velocity: 0.30 }, { rpe: 8.5, velocity: 0.40 }, { rpe: 7, velocity: 0.50 }],
  'bench-press': [{ rpe: 10, velocity: 0.20 }, { rpe: 8.5, velocity: 0.28 }, { rpe: 7, velocity: 0.35 }],
  'deadlift-conventional': [{ rpe: 10, velocity: 0.20 }, { rpe: 8.5, velocity: 0.25 }, { rpe: 7, velocity: 0.30 }],
  'deadlift-sumo': [{ rpe: 10, velocity: 0.15 }, { rpe: 8.5, velocity: 0.22 }, { rpe: 7, velocity: 0.28 }],
  'deadlift-trapbar': [{ rpe: 10, velocity: 0.33 }, { rpe: 8.5, velocity: 0.44 }, { rpe: 7, velocity: 0.55 }],
  'barbell-row': [{ rpe: 10, velocity: 0.45 }, { rpe: 8.5, velocity: 0.55 }, { rpe: 7, velocity: 0.65 }],
}

/**
 * Minimum velocity threshold — the slowest a lifter can still complete a
 * maximum-effort single. Published as a range because a novice grinds out a max
 * far slower than an elite lifter does.
 */
export const MVT_RANGE: Partial<Record<VbtLift, { novice: number; elite: number }>> = {
  'back-squat': { novice: 0.35, elite: 0.20 },
  'front-squat': { novice: 0.45, elite: 0.25 },
  'bench-press': { novice: 0.30, elite: 0.15 },
  'deadlift-conventional': { novice: 0.25, elite: 0.12 },
  'deadlift-sumo': { novice: 0.25, elite: 0.10 },
  'deadlift-trapbar': { novice: 0.45, elite: 0.30 },
  'barbell-row': { novice: 0.50, elite: 0.40 },
  'overhead-press': { novice: 0.35, elite: 0.20 },
}

/** Agreement band between a called RPE and the bar. Anything inside it is a match. */
export const LRV_TOLERANCE_MS = 0.03

/** How the source labels its three anchors, for UI copy. */
export function effortLabel(rpe: number): string {
  if (rpe >= 9.5) return 'max out'
  if (rpe >= 8) return 'tough'
  if (rpe >= 6.5) return 'moderate'
  return 'easy'
}

// ---------------------------------------------------------------------------
// 3. Line fitting
// ---------------------------------------------------------------------------

export interface Fit {
  slope: number
  intercept: number
  /** Coefficient of determination, 0–1. Exactly 1 for points on a true line. */
  r2: number
  n: number
}

/**
 * Ordinary least-squares line through the points.
 *
 * Returns null rather than a line whenever one cannot honestly be drawn: fewer
 * than two points, or every point at the same x. That second case is the one
 * that matters in practice — three sets all at 100 kg have zero x-variance, and
 * dividing by it would hand back an Infinity slope that renders as a confident
 * but meaningless 1RM.
 */
export function fitLine(points: { x: number; y: number }[]): Fit | null {
  const n = points.length
  if (n < 2) return null

  let sx = 0, sy = 0
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    sx += p.x
    sy += p.y
  }
  const mx = sx / n
  const my = sy / n

  let sxx = 0, sxy = 0
  for (const p of points) {
    sxx += (p.x - mx) * (p.x - mx)
    sxy += (p.x - mx) * (p.y - my)
  }
  if (sxx < 1e-12) return null

  const slope = sxy / sxx
  const intercept = my - slope * mx

  // Total sum of squares of zero means every y is identical — the line is
  // perfect by construction, so report r2 = 1 rather than 0/0.
  let ssTot = 0, ssRes = 0
  for (const p of points) {
    const predicted = intercept + slope * p.x
    ssTot += (p.y - my) * (p.y - my)
    ssRes += (p.y - predicted) * (p.y - predicted)
  }
  const r2 = ssTot < 1e-12 ? 1 : Math.max(0, 1 - ssRes / ssTot)

  return { slope, intercept, r2, n }
}

// ---------------------------------------------------------------------------
// 4. RPE <-> last rep velocity
// ---------------------------------------------------------------------------

/**
 * Anchors to use for a lift: the athlete's own if there are enough of them,
 * otherwise the published table.
 *
 * "Enough" is three anchors across at least two distinct RPEs. Two points always
 * fit a line perfectly, which looks like certainty and is not; and anchors all
 * called at the same RPE say nothing about the slope.
 */
export function resolveAnchors(
  lift: VbtLift,
  personal?: LrvAnchor[],
): { anchors: LrvAnchor[]; source: 'personal' | 'published' } | null {
  const usable = (personal ?? []).filter(
    (a) => Number.isFinite(a.rpe) && Number.isFinite(a.velocity) && a.velocity > 0,
  )
  const distinctRpe = new Set(usable.map((a) => a.rpe)).size
  if (usable.length >= 3 && distinctRpe >= 2) return { anchors: usable, source: 'personal' }

  const published = LRV_ANCHORS[lift]
  return published ? { anchors: published, source: 'published' } : null
}

interface Curve {
  velocityAt(rpe: number): number
  /** Null only when the curve is flat and there is nothing to invert. */
  rpeAt(velocity: number): number | null
  fit: Fit
}

/** Straight line through the anchors — the model for noisy personal data. */
function lineCurve(anchors: LrvAnchor[]): Curve | null {
  const fit = fitLine(anchors.map((a) => ({ x: a.rpe, y: a.velocity })))
  if (!fit) return null
  return {
    fit,
    velocityAt: (rpe) => fit.intercept + fit.slope * rpe,
    rpeAt: (v) => (Math.abs(fit.slope) < 1e-9 ? null : (v - fit.intercept) / fit.slope),
  }
}

/**
 * Straight segments between the anchors, extended beyond the ends by the slope
 * of the outermost segment.
 *
 * Used for the published table so the chart shows the coach exactly the numbers
 * they can look up in the source. A least-squares line through them would be
 * close, but not exact: bench and sumo anchors bend slightly, so a regression
 * puts sumo at RPE 10 on 0.152 m/s where the source says 0.15. That gap is far
 * below what a phone camera can resolve — but a reference table that does not
 * match its own reference is a credibility problem, not a precision one.
 *
 * Requires strictly decreasing velocity as RPE rises, which every published lift
 * satisfies; anything else returns null so the caller falls back to a line.
 */
function piecewiseCurve(anchors: LrvAnchor[]): Curve | null {
  const pts = [...anchors].sort((a, b) => a.rpe - b.rpe)
  if (pts.length < 2) return null
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].rpe <= pts[i - 1].rpe || pts[i].velocity >= pts[i - 1].velocity) return null
  }

  const fit = fitLine(pts.map((p) => ({ x: p.rpe, y: p.velocity })))
  if (!fit) return null

  const last = pts.length - 1
  const slopeOf = (i: number) => (pts[i + 1].velocity - pts[i].velocity) / (pts[i + 1].rpe - pts[i].rpe)

  const velocityAt = (rpe: number): number => {
    if (rpe <= pts[0].rpe) return pts[0].velocity + slopeOf(0) * (rpe - pts[0].rpe)
    if (rpe >= pts[last].rpe) return pts[last].velocity + slopeOf(last - 1) * (rpe - pts[last].rpe)
    let i = 0
    while (i < last - 1 && rpe > pts[i + 1].rpe) i++
    return pts[i].velocity + slopeOf(i) * (rpe - pts[i].rpe)
  }

  const rpeAt = (v: number): number => {
    // Velocity falls as RPE rises, so a fast bar is off the LOW-RPE end.
    if (v >= pts[0].velocity) return pts[0].rpe + (v - pts[0].velocity) / slopeOf(0)
    if (v <= pts[last].velocity) return pts[last].rpe + (v - pts[last].velocity) / slopeOf(last - 1)
    let i = 0
    while (i < last - 1 && v < pts[i + 1].velocity) i++
    return pts[i].rpe + (v - pts[i].velocity) / slopeOf(i)
  }

  return { fit, velocityAt, rpeAt }
}

export interface LrvChart {
  source: 'personal' | 'published'
  rows: { rpe: number; velocity: number }[]
  /** Straight-line summary — its `slope` is the m/s lost per RPE point. */
  fit: Fit
  velocityAt(rpe: number): number
  rpeAt(velocity: number): number | null
}

/**
 * Predicted last-rep velocity at every RPE on the chart (5–10, half steps).
 *
 * The published table is interpolated so its own numbers come back unchanged;
 * an athlete's own anchors are regressed, because those are measurements with
 * noise in them and averaging is the point. Both extrapolate off the ends of the
 * anchor range, which is what the source's converter does too.
 *
 * Null when the lift has no published anchors and the athlete has none either —
 * an empty chart is the honest answer, not a flat line at some default.
 */
export function lrvChart(lift: VbtLift, personal?: LrvAnchor[]): LrvChart | null {
  const resolved = resolveAnchors(lift, personal)
  if (!resolved) return null

  const curve =
    resolved.source === 'published'
      ? piecewiseCurve(resolved.anchors) ?? lineCurve(resolved.anchors)
      : lineCurve(resolved.anchors)
  if (!curve) return null

  return {
    source: resolved.source,
    fit: curve.fit,
    velocityAt: curve.velocityAt,
    rpeAt: curve.rpeAt,
    rows: RPE_VALUES.map((rpe) => ({ rpe, velocity: curve.velocityAt(rpe) })),
  }
}

export interface LrvReading {
  /** Estimated RPE, clamped onto the 5–10 chart and rounded to a half step. */
  rpe: number
  /** The unclamped value, for callers that want to say "faster than RPE 5". */
  rawRpe: number
  outsideChart: boolean
  source: 'personal' | 'published'
  /** Set only when a called RPE was supplied. */
  agreement: 'match' | 'harder' | 'easier' | null
}

/**
 * The RPE that last rep's velocity implies.
 *
 * Inverts the chart line rather than searching its rows, so the answer is
 * continuous. `agreement` compares against what the coach called using the
 * source's ±0.03 m/s band — and note it compares in VELOCITY, not in RPE: the
 * band is stated in m/s and converting it to RPE points would stretch or shrink
 * it differently for every lift.
 */
export function rpeFromLastRepVelocity(
  lift: VbtLift,
  velocity: number,
  opts: { anchors?: LrvAnchor[]; calledRpe?: number | null } = {},
): LrvReading | null {
  if (!Number.isFinite(velocity) || velocity <= 0) return null
  const chart = lrvChart(lift, opts.anchors)
  // A flat chart predicts the same velocity at every RPE — nothing to invert.
  const rawRpe = chart?.rpeAt(velocity)
  if (!chart || rawRpe == null || !Number.isFinite(rawRpe)) return null

  const min = RPE_VALUES[0]
  const max = RPE_VALUES[RPE_VALUES.length - 1]
  const clamped = Math.min(max, Math.max(min, rawRpe))

  let agreement: LrvReading['agreement'] = null
  if (opts.calledRpe != null && Number.isFinite(opts.calledRpe)) {
    const delta = velocity - chart.velocityAt(opts.calledRpe)
    if (Math.abs(delta) <= LRV_TOLERANCE_MS) agreement = 'match'
    // Slower than the called RPE predicts means the set was HARDER than called.
    // The sign flips with the slope, which is negative for every real lift
    // (higher RPE, slower bar) — so compare velocities, never raw deltas.
    else agreement = delta < 0 ? 'harder' : 'easier'
  }

  return {
    rpe: Math.round(clamped * 2) / 2,
    rawRpe,
    outsideChart: rawRpe < min - 1e-9 || rawRpe > max + 1e-9,
    source: chart.source,
    agreement,
  }
}

/**
 * The RPE to act on, given what the bar said and what the coach called.
 *
 * Inside the ±0.03 m/s band the two are indistinguishable by definition, so the
 * coach's number stands — a bar reading of 6.5 against a called 7 that are 0.02
 * m/s apart is agreement, and headlining the 6.5 would read as a contradiction.
 * Outside the band the bar's own estimate is the answer.
 */
export function effectiveRpe(reading: LrvReading, calledRpe?: number | null): number {
  return reading.agreement === 'match' && calledRpe != null ? calledRpe : reading.rpe
}

// ---------------------------------------------------------------------------
// 5. Load-velocity profile
// ---------------------------------------------------------------------------

export interface LvPoint {
  load: number
  /** Mean concentric velocity for the set, m/s. */
  velocity: number
  label?: string
}

export type LvWarning = 'too-few-points' | 'narrow-load-range' | 'poor-fit' | 'positive-slope'

export interface LoadVelocityProfile {
  fit: Fit
  mvt: number
  /** Load at which velocity falls to the MVT. Null when the fit slopes the wrong way. */
  oneRm: number | null
  loadForVelocity(v: number): number | null
  velocityForLoad(load: number): number | null
  pctOf1RM(load: number): number | null
  warnings: LvWarning[]
  points: LvPoint[]
}

const MIN_PROFILE_POINTS = 3
const MIN_LOAD_SPREAD_PCT = 0.15
const MIN_R2 = 0.9

/**
 * Fits velocity = intercept + slope·load and reads the 1RM off it at the MVT.
 *
 * The warnings matter as much as the number. Three sets bunched within 5 kg of
 * each other will fit a line beautifully and extrapolate to a 1RM that is pure
 * noise, so the conditions the source states — at least three sets, spread
 * across roughly 60–90% of the max — are returned as data for the UI to show
 * rather than being silently ignored.
 */
export function buildLoadVelocityProfile(points: LvPoint[], mvt: number): LoadVelocityProfile | null {
  const usable = points.filter(
    (p) => Number.isFinite(p.load) && p.load > 0 && Number.isFinite(p.velocity) && p.velocity > 0,
  )
  const fit = fitLine(usable.map((p) => ({ x: p.load, y: p.velocity })))
  if (!fit || !Number.isFinite(mvt) || mvt <= 0) return null

  const oneRm = fit.slope < 0 ? (mvt - fit.intercept) / fit.slope : null

  const warnings: LvWarning[] = []
  if (usable.length < MIN_PROFILE_POINTS) warnings.push('too-few-points')
  if (fit.slope >= 0) warnings.push('positive-slope')
  if (fit.r2 < MIN_R2) warnings.push('poor-fit')
  if (oneRm && oneRm > 0) {
    const loads = usable.map((p) => p.load)
    const spread = Math.max(...loads) - Math.min(...loads)
    if (spread / oneRm < MIN_LOAD_SPREAD_PCT) warnings.push('narrow-load-range')
  }

  const loadForVelocity = (v: number) => {
    if (!Number.isFinite(v) || Math.abs(fit.slope) < 1e-12) return null
    const load = (v - fit.intercept) / fit.slope
    return load > 0 ? load : null
  }
  const velocityForLoad = (load: number) => {
    if (!Number.isFinite(load)) return null
    const v = fit.intercept + fit.slope * load
    return v > 0 ? v : null
  }

  return {
    fit,
    mvt,
    oneRm: oneRm && oneRm > 0 ? oneRm : null,
    loadForVelocity,
    velocityForLoad,
    pctOf1RM: (load) => (oneRm && oneRm > 0 && Number.isFinite(load) ? load / oneRm : null),
    warnings,
    points: usable,
  }
}

// ---------------------------------------------------------------------------
// 5b. Estimated 1RM from a single set
// ---------------------------------------------------------------------------
//
// The profile above needs three loads. This gets a max out of ONE set, by
// running the same line through a single measured point instead of fitting it:
//
//     %1RM = 100 − slope · (velocity − MVT)
//
// The line is anchored at the MVT, because that anchor is the one part of it
// this app already knows per lift AND can personalise (see defaultMvt). All
// that is left to supply is the slope — and where that comes from is the whole
// accuracy question, so it is returned alongside the answer rather than buried.

export type SlopeSource = 'profile' | 'calibrated' | 'published' | 'estimated'

export interface LvSlope {
  /** %1RM lost per m/s of extra bar speed. Always positive. */
  slope: number
  source: SlopeSource
}

/**
 * Fallback slopes in %1RM per m/s.
 *
 * Only the conventional deadlift figure is published: Benavides-Ubric (2020),
 * n=50, %1RM = 124.9 − 80.2·MV at R² = 0.91, cited on VBTcoach's load-velocity
 * profiling page. Everything else is `DEFAULT_LV_SLOPE`.
 *
 * That single default is defensible rather than lazy. Across barbell lifts it is
 * mostly the INTERCEPT that moves — a bench 1RM crawls where a trap-bar pull
 * still travels — and that intercept is exactly what MVT_RANGE already carries
 * per lift. The slope itself sits in a much narrower band. What must not happen
 * is inventing a precise-looking per-lift number for each: the published
 * squat and bench equations are in mean PROPULSIVE velocity, which runs faster
 * than the mean velocity this tracker measures, so converting them by eye would
 * manufacture false precision.
 */
export const DEFAULT_LV_SLOPE = 75

export const LV_SLOPES: Partial<Record<VbtLift, LvSlope>> = {
  'deadlift-conventional': { slope: 80.2, source: 'published' },
}

export function populationSlope(lift: VbtLift): LvSlope {
  return LV_SLOPES[lift] ?? { slope: DEFAULT_LV_SLOPE, source: 'estimated' }
}

/**
 * The athlete's own slope, from a known 1RM and one set measured against it.
 *
 * Two real points — (load, velocity) and (1RM, MVT) — so no population figure is
 * involved at all. This is the accurate path, and it needs only a max the coach
 * has already recorded plus a single tracked set.
 *
 * Null when the set is at or above the recorded max, or at or below the MVT:
 * both put the two anchors on top of each other, and neither describes a line.
 */
export function calibratedSlope(opts: {
  knownMax: number
  loadKg: number
  velocity: number
  mvt: number
}): number | null {
  const { knownMax, loadKg, velocity, mvt } = opts
  if (!(knownMax > 0) || !(loadKg > 0) || loadKg >= knownMax) return null
  if (!(velocity > mvt)) return null
  const pct = (loadKg / knownMax) * 100
  return (100 - pct) / (velocity - mvt)
}

/**
 * The slope to use, best evidence first.
 *
 * A fitted profile beats a calibration off one set, which beats anything from a
 * population — and the source travels with the number so the UI can say which
 * of the three is talking rather than presenting all three as equally certain.
 */
export function resolveLvSlope(
  lift: VbtLift,
  opts: {
    profile?: LoadVelocityProfile | null
    calibration?: { knownMax: number; loadKg: number; velocity: number; mvt: number } | null
  } = {},
): LvSlope {
  const p = opts.profile
  // A profile's slope is in m/s per kg; converting needs its own 1RM, which is
  // the load that makes 100% mean something.
  if (p && p.oneRm != null && p.fit.slope < 0 && p.fit.n >= 2) {
    return { slope: -(100 / p.oneRm) / p.fit.slope, source: 'profile' }
  }
  if (opts.calibration) {
    const slope = calibratedSlope(opts.calibration)
    if (slope != null && slope > 0) return { slope, source: 'calibrated' }
  }
  return populationSlope(lift)
}

export interface VelocityE1RM {
  e1rm: number
  /** Where this set sat, as a fraction of the estimate. */
  pctOf1RM: number
  mvt: number
  slope: LvSlope
}

/**
 * Estimated 1RM from one set's load and bar speed.
 *
 * `velocity` MUST be the set's FASTEST rep, not its last — see bestRepVelocity.
 * The load-velocity relationship describes how fast a given load moves under
 * full intent when fresh, so feeding it a fatigued last rep reads the load as
 * far heavier than it is, and increasingly so the longer the set. A real 180 kg
 * five-rep squat by a 250 kg squatter: the last rep at 0.39 m/s estimates 201
 * kg, the first at 0.62 m/s estimates 249. Last-rep velocity answers a different
 * question — how hard the set was — which is rpeFromLastRepVelocity's job.
 *
 * Deliberately does NOT go via reps and the RPE chart either. RPE-to-%1RM is
 * highly individual — a strong lifter routinely has more in reserve than the
 * chart assumes — whereas velocity at a given relative load is the one thing VBT
 * finds consistent.
 *
 * Null when the bar was at or below the MVT (the set was already a max or the
 * scale is wrong) or when the arithmetic would produce a non-positive max.
 */
export function e1RMFromVelocity(opts: {
  loadKg: number
  /** The fastest rep of the set, in m/s. */
  velocity: number
  mvt: number
  slope: LvSlope
}): VelocityE1RM | null {
  const { loadKg, velocity, mvt, slope } = opts
  if (!(loadKg > 0) || !Number.isFinite(velocity) || !(mvt > 0) || !(slope.slope > 0)) return null
  if (velocity <= mvt) return null

  const pct = (100 - slope.slope * (velocity - mvt)) / 100
  // A bar moving far faster than the MVT can drive this to zero or below, which
  // is the model saying the set is outside the range a straight line describes.
  if (!(pct > 0.05) || pct > 1) return null

  return { e1rm: loadKg / pct, pctOf1RM: pct, mvt, slope }
}

// ---------------------------------------------------------------------------
// 5c. Matching a VBT lift to a recorded max
// ---------------------------------------------------------------------------
// `athlete_maxes.lift_name` is free text the coach typed, so this is a
// tolerant match rather than a lookup. Exclusions matter more than inclusions:
// "Front Squat" must not satisfy a plain back squat, and "Bench Press" must not
// satisfy the overhead press.

const LIFT_NAME_RULES: Partial<Record<VbtLift, { any: string[]; not?: string[] }>> = {
  'back-squat': {
    any: ['squat'],
    not: ['front', 'box', 'split', 'hack', 'pin', 'safety', 'bulgarian', 'goblet', 'overhead'],
  },
  'front-squat': { any: ['front squat', 'frontsquat'] },
  'bench-press': { any: ['bench'], not: ['pull'] },
  'deadlift-conventional': {
    any: ['deadlift', 'dead lift'],
    not: ['sumo', 'trap', 'hex', 'romanian', 'rdl', 'stiff', 'deficit', 'rack', 'block', 'snatch'],
  },
  'deadlift-sumo': { any: ['sumo'] },
  'deadlift-trapbar': { any: ['trap bar', 'trapbar', 'hex bar', 'hexbar'] },
  'barbell-row': { any: ['row'] },
  'overhead-press': { any: ['overhead', 'ohp', 'military', 'strict press'] },
}

/** Whether a free-text lift name refers to this VBT lift. */
export function matchesLiftName(lift: VbtLift, liftName: string): boolean {
  const rule = LIFT_NAME_RULES[lift]
  if (!rule) return false
  const name = liftName.toLowerCase().trim()
  if (rule.not?.some((n) => name.includes(n))) return false
  return rule.any.some((a) => name.includes(a))
}

/**
 * The heaviest recorded max that refers to this lift.
 *
 * Heaviest rather than most recent: a max is a PR, and the app already keeps the
 * full history, so an older heavier entry is still the best evidence of what the
 * athlete can do. Callers pass whatever `athlete_maxes` rows they hold.
 */
export function recordedMaxFor(
  lift: VbtLift,
  maxes: { lift_name: string; weight: number }[],
): number | null {
  const weights = maxes
    .filter((m) => matchesLiftName(lift, m.lift_name) && m.weight > 0)
    .map((m) => m.weight)
  return weights.length ? Math.max(...weights) : null
}

/**
 * The MVT to start from for a lift.
 *
 * Taken from the LRV chart's own RPE-10 row rather than from MVT_RANGE, because
 * they are the same quantity by definition — the MVT *is* the last-rep velocity
 * of a maximum single. Deriving it keeps one number instead of two that can
 * drift apart, and it personalises for free once the athlete has their own
 * anchors. MVT_RANGE is the fallback for lifts with no LRV table, and stays
 * exported as the sanity band to show beside the field.
 */
export function defaultMvt(lift: VbtLift, personal?: LrvAnchor[]): number | null {
  const chart = lrvChart(lift, personal)
  const atTen = chart?.rows.find((r) => r.rpe === 10)
  if (atTen && atTen.velocity > 0) return atTen.velocity

  const range = MVT_RANGE[lift]
  return range ? (range.novice + range.elite) / 2 : null
}

// ---------------------------------------------------------------------------
// 6. Velocity zones
// ---------------------------------------------------------------------------
// NOT from the vbtcoach sources above. These are the classic training-quality
// bands from the wider VBT literature (Mann's velocity zones), included because
// they answer a different question — "what quality did this set train?" rather
// than "how hard was it?". Kept in its own block, and labelled as general
// reference in the UI, so a coach can always tell which numbers came from where.

export interface VelocityZone {
  id: string
  label: string
  /** Inclusive lower bound, m/s. */
  min: number
  /** Exclusive upper bound, m/s. Infinity for the top band. */
  max: number
  summary: string
}

export const VELOCITY_ZONES: VelocityZone[] = [
  { id: 'absolute-strength', label: 'Absolute strength', min: 0.15, max: 0.5, summary: 'Heavy, near-maximal loads' },
  { id: 'accelerative-strength', label: 'Accelerative strength', min: 0.5, max: 0.75, summary: 'Heavy loads moved with intent' },
  { id: 'strength-speed', label: 'Strength-speed', min: 0.75, max: 1.0, summary: 'Moderate-heavy, force-dominant power' },
  { id: 'speed-strength', label: 'Speed-strength', min: 1.0, max: 1.3, summary: 'Lighter, velocity-dominant power' },
  { id: 'starting-strength', label: 'Starting strength', min: 1.3, max: Infinity, summary: 'Light and fast — rate of force development' },
]

/** The zone a mean concentric velocity falls in, or null below the lowest band. */
export function zoneFor(velocity: number): VelocityZone | null {
  if (!Number.isFinite(velocity)) return null
  return VELOCITY_ZONES.find((z) => velocity >= z.min && velocity < z.max) ?? null
}

// ---------------------------------------------------------------------------
// 7. Reading a tracked set
// ---------------------------------------------------------------------------

/**
 * Velocity of the last rep — the number every LRV judgement is made on.
 *
 * Mean concentric velocity, in m/s, and null on an uncalibrated track: a
 * px/s figure carries no meaning against a published m/s table, and quietly
 * comparing them would produce nonsense with no visible symptom.
 */
export function lastRepVelocity(reps: RepMetrics[]): number | null {
  const last = reps[reps.length - 1]
  return last?.meanVelocity ?? null
}

/** Fastest mean concentric velocity in the set — the load-velocity profile's y value. */
export function bestRepVelocity(reps: RepMetrics[]): number | null {
  const speeds = reps.map((r) => r.meanVelocity).filter((v): v is number => v != null)
  return speeds.length ? Math.max(...speeds) : null
}

/** Below this many reps a velocity-loss percentage is not worth reading — see velocityLoss. */
export const MIN_REPS_FOR_VELOCITY_LOSS = 4

export interface VelocityLossReading {
  /** Drop from the fastest rep to the last, as a percentage. */
  lossPct: number
  /**
   * False on short sets.
   *
   * Most strength work sits at 1-3 reps, where there is barely any drop-off to
   * measure; and on a low-readiness day the first rep is already slow, which
   * flatters the percentage exactly when fatigue is highest. Last-rep velocity
   * is the signal to read in those cases, which is why this is a flag on the
   * reading rather than a reason to hide it.
   */
  reliable: boolean
  reps: number
  /** True when the numbers are pixels/second, so the percentage is still valid but the units are not. */
  uncalibrated: boolean
}

/**
 * Velocity loss across a set.
 *
 * A ratio, so it is unit-free — an uncalibrated track gives the same percentage
 * in px/s that it would in m/s, and this is the one VBT number that survives
 * having no scale line.
 */
export function velocityLoss(reps: RepMetrics[]): VelocityLossReading | null {
  if (reps.length < 2) return null
  const uncalibrated = reps.some((r) => r.meanVelocity == null)
  const speeds = reps.map((r) => r.meanVelocity ?? r.meanVelocityPxS)
  const best = Math.max(...speeds)
  if (!(best > 0)) return null

  return {
    lossPct: (1 - speeds[speeds.length - 1] / best) * 100,
    reliable: reps.length >= MIN_REPS_FOR_VELOCITY_LOSS,
    reps: reps.length,
    uncalibrated,
  }
}
