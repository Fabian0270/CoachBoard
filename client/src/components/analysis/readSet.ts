import { looksMistracked, type RepMetrics } from 'coachboard-shared/videoAnalysis'
import {
  bestRepVelocity,
  buildLoadVelocityProfile,
  e1RMFromVelocity,
  isPlausibleMvt,
  lastRepVelocity,
  lrvChart,
  recordedMaxFor,
  resolveLvSlope,
  resolveMvt,
  rpeFromLastRepVelocity,
  velocityLoss,
  type LrvAnchor,
  type LvPoint,
  type VbtLift,
  type VelocityMetric,
} from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// What one tracked set says: the RPE its last rep reads as, the max it
// estimates, and every step in between.
//
// One function for the live panel and the saved page (BP3). The saved page
// used to work this out on its own — the fastest rep including mistracked
// ones, on the population slope only — so the same set showed two different
// estimated maxes depending on which page it was opened on.
// ---------------------------------------------------------------------------

export interface SetReadingInput {
  reps: RepMetrics[]
  lift: VbtLift
  metric: VelocityMetric
  /** A scale line was drawn. Without it nothing here is in m/s, and nothing is read. */
  calibrated: boolean
  loadKg: number | null
  calledRpe: number | null
  /** Every RPE anchor for this lift, THIS set included. */
  anchors: LrvAnchor[]
  /** The athlete's stored 1RM velocity for this lift. */
  storedMvt: number | null
  /** A 1RM velocity the coach typed for this set; ignored when implausible. */
  typedMvt?: number | null
  /** The athlete's OTHER saved sets for this lift, newest first — never this one. */
  savedPoints: LvPoint[]
  /** Recorded maxes, for calibrating the slope against a real one. */
  maxes: { lift_name: string; weight: number }[]
}

export function readSet(i: SetReadingInput) {
  /**
   * Reps whose peak is wildly out of line with their mean. Peak is a
   * near-single-sample statistic, so a tracker re-lock lands in it whole; a
   * set read off peak leaves those reps out. No reading beats a confident
   * wrong one.
   */
  const mistracked = i.reps.filter(looksMistracked)
  const trusted = i.reps.filter((r) => !looksMistracked(r))
  const readable = i.metric === 'peak' ? trusted : i.reps

  const lastV = i.calibrated ? lastRepVelocity(readable, i.metric) : null
  const bestV = i.calibrated ? bestRepVelocity(readable, i.metric) : null

  const chart = lrvChart(i.lift, i.anchors)
  const reading = lastV == null
    ? null
    : rpeFromLastRepVelocity(i.lift, lastV, { anchors: i.anchors, calledRpe: i.calledRpe })
  const loss = velocityLoss(i.reps)
  const knownMax = recordedMaxFor(i.lift, i.maxes)

  // This athlete's stored number wins, then the RPE-10 row of their own chart;
  // the published band is the last resort. A typed value overrides it when
  // it is plausible ("25" meant as 0.25 would put a nonsense max on screen).
  const suggestedMvt = resolveMvt(i.lift, { stored: i.storedMvt, anchors: i.anchors })
  const mvt = isPlausibleMvt(i.typedMvt ?? null) ? i.typedMvt! : suggestedMvt

  const lvPoints: LvPoint[] = [...i.savedPoints]
  if (i.loadKg != null && bestV != null) lvPoints.push({ load: i.loadKg, velocity: bestV, label: 'this set' })
  const profile = mvt != null ? buildLoadVelocityProfile(lvPoints, mvt) : null

  // Calibrated off the most recent OTHER saved set: calibrating off the set
  // being estimated just hands the recorded max straight back.
  const calibration = knownMax != null && mvt != null && i.savedPoints.length > 0
    ? { knownMax, loadKg: i.savedPoints[0].load, velocity: i.savedPoints[0].velocity, mvt }
    : null
  const slope = resolveLvSlope(i.lift, { profile, calibration })

  // The FASTEST rep, not the last: the load-velocity relationship describes a
  // load moved fresh under full intent; a fatigued last rep reads it as far
  // heavier than it is.
  const estimate = bestV != null && i.loadKg != null && mvt != null
    ? e1RMFromVelocity({ loadKg: i.loadKg, velocity: bestV, mvt, slope })
    : null

  return { mistracked, trusted, readable, lastV, bestV, chart, reading, loss, knownMax, suggestedMvt, mvt, lvPoints, profile, calibration, slope, estimate }
}

export type SetReading = ReturnType<typeof readSet>
