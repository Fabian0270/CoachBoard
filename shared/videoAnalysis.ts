// ---------------------------------------------------------------------------
// Bar-path metrics (Feature 11b).
//
// Pure functions over a tracked path — no I/O, no DOM, no opencv. Same "math as
// data" shape as shared/rpe.ts and shared/scoring.ts, which is what makes it
// testable under the client's node-only test runner while the tracking itself
// can only run in a browser.
//
// Coordinate convention throughout: `y` is IMAGE space, so it grows DOWNWARD.
// Concentric (the lifting half) therefore means y DECREASING — true for squat,
// bench, deadlift and press alike, since the concentric is always the half that
// fights gravity.
// ---------------------------------------------------------------------------

/** One tracked bar position. Spacing is irregular by design — see verticalVelocity. */
export interface Sample {
  t: number
  x: number
  y: number
}

export interface VelocitySample {
  t: number
  /** Signed vertical velocity in pixels/second. Negative = moving up. */
  vy: number
}

/**
 * Solves the weighted-least-squares normal equations for the LINEAR term only.
 *
 * Fitting y = c0 + c1·dt + c2·dt² and taking the derivative at dt=0 gives
 * exactly c1, so the other two coefficients are never needed. Cramer's rule on
 * the 3x3 system is cheaper and far less error-prone by hand than a general
 * solver would be here.
 */
function solveLinearTerm(
  sw: number, swx: number, swx2: number, swx3: number, swx4: number,
  swy: number, swxy: number, swx2y: number,
): number | null {
  const det =
    sw * (swx2 * swx4 - swx3 * swx3) -
    swx * (swx * swx4 - swx3 * swx2) +
    swx2 * (swx * swx3 - swx2 * swx2)
  // Degenerate window (all points at effectively the same time) — no slope to read.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null

  const detC1 =
    sw * (swxy * swx4 - swx3 * swx2y) -
    swy * (swx * swx4 - swx3 * swx2) +
    swx2 * (swx * swx2y - swxy * swx2)

  return detC1 / det
}

/**
 * Vertical velocity by local weighted quadratic regression over a ±window in TIME.
 *
 * Deliberately not a fixed-kernel filter such as Savitzky-Golay: those assume
 * uniform sample spacing, and phone video is routinely variable-frame-rate, so
 * a fixed kernel would misweight neighbours whose real time gap differs from
 * what it assumes — quietly skewing every velocity it produced. Regressing
 * against actual timestamps makes irregular spacing a non-issue.
 *
 * Raw finite differences on tracked pixel positions are far too noisy to report
 * as velocity, which is why this fits a curve rather than differencing points.
 */
export function verticalVelocity(samples: Sample[], windowMs = 150): VelocitySample[] {
  if (samples.length < 2) return samples.map((s) => ({ t: s.t, vy: 0 }))

  const half = windowMs / 2000 // ms -> s, then halved
  const centralDifference = (i: number): number => {
    const a = samples[Math.max(0, i - 1)]
    const b = samples[Math.min(samples.length - 1, i + 1)]
    const dt = b.t - a.t
    return dt > 0 ? (b.y - a.y) / dt : 0
  }

  return samples.map((s, i) => {
    let sw = 0, swx = 0, swx2 = 0, swx3 = 0, swx4 = 0, swy = 0, swxy = 0, swx2y = 0
    let count = 0

    for (const p of samples) {
      const dt = p.t - s.t
      if (Math.abs(dt) > half) continue
      // Triangular weighting: neighbours count for less the further out they
      // are, which keeps the fit centred rather than dragged by window edges.
      const w = Math.max(1 - Math.abs(dt) / half, 0.01)
      const x2 = dt * dt
      sw += w
      swx += w * dt
      swx2 += w * x2
      swx3 += w * x2 * dt
      swx4 += w * x2 * x2
      swy += w * p.y
      swxy += w * dt * p.y
      swx2y += w * x2 * p.y
      count++
    }

    // A quadratic needs three points; near the clip edges fall back to a plain
    // central difference rather than reporting a fabricated zero.
    if (count < 3) return { t: s.t, vy: centralDifference(i) }

    const vy = solveLinearTerm(sw, swx, swx2, swx3, swx4, swy, swxy, swx2y)
    return { t: s.t, vy: vy ?? centralDifference(i) }
  })
}

/** Where the propulsive phase ends: the bar decelerating at least as hard as gravity. */
const GRAVITY_MS2 = 9.81

/**
 * Vertical acceleration at one sample, in pixels/s², by local weighted linear
 * regression of velocity against time.
 *
 * A plain difference of two velocity samples is far too noisy to threshold
 * against gravity — the whole point of the phase boundary is that it sits at a
 * specific number, so the signal has to be smooth enough for that number to
 * mean something. Regressing against real timestamps for the same reason
 * verticalVelocity does: phone video is variable-frame-rate.
 */
function accelerationAt(velocities: VelocitySample[], index: number, halfWindowS: number): number {
  const centre = velocities[index]
  let sw = 0, swx = 0, swx2 = 0, swy = 0, swxy = 0
  let count = 0

  for (const p of velocities) {
    const dt = p.t - centre.t
    if (Math.abs(dt) > halfWindowS) continue
    const w = Math.max(1 - Math.abs(dt) / halfWindowS, 0.01)
    sw += w
    swx += w * dt
    swx2 += w * dt * dt
    swy += w * p.vy
    swxy += w * dt * p.vy
    count++
  }
  if (count < 2) return 0

  const det = sw * swx2 - swx * swx
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return 0
  return (sw * swxy - swx * swy) / det
}

/** One lifting cycle, as indices into the sample array. */
export interface Rep {
  index: number
  /** The bottom position this rep starts from. */
  startIndex: number
  /** The next bottom, or the last sample for a final incomplete rep. */
  endIndex: number
  /** The top of the lift — end of the concentric half. */
  topIndex: number
  /** Vertical travel, kept so the set can be compared against its own median. */
  romPx: number
}

export interface SegmentOptions {
  /** Below this |vy| the bar counts as stationary, so jitter at a turnaround
   *  is not mistaken for a direction change. Pixels/second. */
  minMovingSpeed?: number
  /** Minimum vertical travel for a cycle to be a rep rather than track noise. */
  minRomPx?: number
  /**
   * Minimum travel as a fraction of the set's OWN median rep, on top of minRomPx.
   *
   * A fixed pixel floor rejects a different amount of noise depending on how
   * zoomed-in the footage is: 20 px is most of a rep on a wide shot and a
   * rounding error on a close one. A real 5-rep squat came back as six reps
   * because of it — the phantom travelled 3 cm against a 100 cm median, which is
   * plainly not a rep at any zoom, but cleared 20 px comfortably.
   *
   * Same reasoning as the dead-time trim in repMetrics, which is a fraction of
   * the rep's own peak rather than a fixed speed, and for the same reason.
   */
  minRomFraction?: number
}

const SEGMENT_DEFAULTS: Required<SegmentOptions> = {
  minMovingSpeed: 15,
  minRomPx: 20,
  minRomFraction: 0.4,
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Splits a tracked path into reps, bottom to bottom.
 *
 * Bottom-to-bottom is the natural cycle for every barbell lift: squat and bench
 * start at the top but turn around at the bottom, and a deadlift starts at the
 * floor. Taking the bottom as the boundary means the concentric half — the part
 * coaches actually measure — always falls INSIDE one rep rather than being
 * split across two.
 */
export function segmentReps(
  samples: Sample[],
  velocities: VelocitySample[],
  options: SegmentOptions = {},
): Rep[] {
  const opts = { ...SEGMENT_DEFAULTS, ...options }
  if (samples.length < 3) return []

  type Direction = 'up' | 'down' | 'still'
  const direction: Direction[] = velocities.map((v) =>
    Math.abs(v.vy) < opts.minMovingSpeed ? 'still' : v.vy < 0 ? 'up' : 'down',
  )

  // Rep boundaries are down->up turns (a y maximum, i.e. the bottom), ignoring
  // 'still' samples entirely so the pause at the bottom of a squat reads as one
  // turnaround rather than several.
  const bottoms: number[] = []
  let previousMoving: Direction | null = null
  for (let i = 0; i < direction.length; i++) {
    const d = direction[i]
    if (d === 'still') continue
    if (previousMoving === 'down' && d === 'up') bottoms.push(i)
    previousMoving = d
  }

  // A clip that opens already at the bottom (very common — coaches trim to the
  // rep) has no down->up transition to find, so its first rep would be lost.
  const firstMoving = direction.find((d) => d !== 'still')
  const starts = firstMoving === 'up' ? [0, ...bottoms] : bottoms

  const reps: Rep[] = []
  for (let i = 0; i < starts.length; i++) {
    const startIndex = starts[i]
    const endIndex = i + 1 < starts.length ? starts[i + 1] : samples.length - 1

    // The top is simply the highest point between this bottom and the next.
    // Taken as a minimum rather than as an up->down turn on purpose: a clip
    // that ends at lockout has no turn after its final concentric, and keying
    // off transitions silently dropped that last rep.
    let topIndex = startIndex
    for (let j = startIndex; j <= endIndex; j++) {
      if (samples[j].y < samples[topIndex].y) topIndex = j
    }

    // Reject anything that barely moved: that is tracker jitter, not a lift.
    const romPx = Math.abs(samples[startIndex].y - samples[topIndex].y)
    if (romPx < opts.minRomPx) continue

    reps.push({ index: reps.length, startIndex, endIndex, topIndex, romPx })
  }

  // Second pass, once there is a set to compare against: drop cycles far
  // shorter than the set's own reps. Median rather than mean so one phantom
  // cannot drag the reference down and save itself.
  if (reps.length < 2) return reps
  const floor = median(reps.map((r) => r.romPx)) * opts.minRomFraction
  return reps.filter((r) => r.romPx >= floor).map((r, index) => ({ ...r, index }))
}

/**
 * Peak velocity is the Nth fastest sample, not the single fastest.
 *
 * A maximum is a one-sample statistic, so on a noisy track it reports the worst
 * sample rather than the fastest the bar went. A real 165 kg bench came back
 * with a 1.69 m/s "peak" — over the 150 ms smoothing window that is the tracked
 * point moving 25 cm, which is a re-lock, not a barbell. The mean was untouched
 * at 0.14, because averaging is what makes it robust.
 *
 * Every velocity read against a reference table needs that same robustness. A
 * glitch spans roughly three samples once the smoothing window has spread it, so
 * this sits low enough to step over one and high enough to stay within a few
 * percent of the true peak on a clean track, where the top samples all sit near
 * the top anyway.
 */
const PEAK_PERCENTILE = 0.88

/** Linear-interpolated percentile of an unsorted list. 0 for an empty one. */
function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/**
 * Above this, a rep's peak is so far clear of its mean that the track glitched
 * rather than the bar moving fast.
 *
 * Real reps measured across squat, bench and deadlift sit between about 1.5 and
 * 3. The glitched bench rep above was 12.
 */
export const SUSPECT_PEAK_RATIO = 4

/** Whether a rep looks mistracked and should be struck off or re-tracked. */
export function looksMistracked(rep: RepMetrics): boolean {
  const mean = rep.meanVelocity ?? rep.meanVelocityPxS
  const peak = rep.peakVelocity ?? rep.peakVelocityPxS
  return mean > 0 && peak / mean > SUSPECT_PEAK_RATIO
}

export interface RepMetrics {
  index: number
  startT: number
  endT: number
  /** Duration of the concentric half. */
  durationMs: number
  romPx: number
  meanVelocityPxS: number
  peakVelocityPxS: number
  /** Metric-unit versions, null until the path has been calibrated. */
  romM: number | null
  meanVelocity: number | null
  peakVelocity: number | null
  /**
   * Mean PROPULSIVE velocity — averaged over only the driven part of the lift,
   * stopping where the bar begins decelerating at least as hard as gravity.
   *
   * Null without a calibration, and not because of the usual unit-honesty rule:
   * the phase boundary is literally 9.81 m/s², so it cannot even be located on
   * an uncalibrated path.
   */
  meanPropulsiveVelocity: number | null
  /** How much of the concentric was propulsive, 0-1. Null when MPV is. */
  propulsiveFraction: number | null
}

/**
 * Concentric metrics for one rep — the bottom-to-top half.
 *
 * Only the concentric is reported because that is what velocity-based training
 * is built on; the eccentric is coach-controlled tempo, not an output.
 */
export function repMetrics(
  rep: Rep,
  samples: Sample[],
  velocities: VelocitySample[],
  pixelsPerMetre: number | null,
): RepMetrics {
  const to = rep.topIndex

  // Trim dead time off the front of the concentric.
  //
  // The turnaround is not the moment the bar starts moving: a deadlift sits on
  // the floor while the lifter builds tension, and a squat pauses in the hole.
  // Including that stationary stretch drags the mean toward zero and makes the
  // headline number meaningless — a real deadlift measured 0.16 m/s mean
  // against a 0.74 m/s peak purely because three seconds of setup were counted
  // as part of the lift.
  //
  // The threshold is a fraction of this rep's own peak rather than a fixed
  // pixel speed, so it holds regardless of how zoomed-in the footage is.
  const windowSpeeds = velocities.slice(rep.startIndex, to + 1).map((v) => Math.abs(v.vy))
  // The robust peak, not the maximum — see PEAK_PERCENTILE. A glitch would
  // otherwise raise this threshold above the real bar speed and trim away the
  // lift itself: on a real 165 kg bench a spurious 1.69 m/s sample put the
  // threshold at 0.169 m/s, above a bar actually travelling 0.14.
  const windowPeak = percentile(windowSpeeds, PEAK_PERCENTILE)
  const movingThreshold = windowPeak * 0.1
  let from = rep.startIndex
  while (from < to && Math.abs(velocities[from].vy) < movingThreshold) from++

  const speeds = velocities.slice(from, to + 1).map((v) => Math.abs(v.vy))
  const meanVelocityPxS = speeds.length
    ? speeds.reduce((sum, s) => sum + s, 0) / speeds.length
    : 0
  const peakVelocityPxS = percentile(speeds, PEAK_PERCENTILE)
  // Range of motion is measured from the TRUE bottom, not the trimmed start:
  // how far the bar travelled and how fast it moved are different questions,
  // and the trim only ever removes time, never distance.
  const romPx = Math.abs(samples[rep.startIndex].y - samples[to].y)
  const toMetres = (px: number) => (pixelsPerMetre && pixelsPerMetre > 0 ? px / pixelsPerMetre : null)

  // ---- Propulsive phase -----------------------------------------------------
  //
  // A barbell is only being driven for part of the concentric. Past a point the
  // lifter has to slow it so it does not leave the hands, and everything after
  // that is deceleration the lifter is causing on purpose. Averaging it in is
  // what makes mean velocity read a bench as far slower than it was: on a 35 cm
  // bench travel the braking phase is a large share of the lift, on a 100 cm
  // squat it is a small one. That is the whole reason bench looked like a max
  // out on every set while squat and deadlift read correctly.
  //
  // The boundary is where the bar starts decelerating at least as hard as
  // gravity. In image coordinates the concentric has vy negative, so upward
  // speed is -vy and its rate of change is -dvy/dt; decelerating harder than
  // gravity therefore means dvy/dt >= +9.81 m/s². Searched from the fastest
  // sample onward, since the bar accelerates before it brakes.
  let propulsiveEnd = to
  if (pixelsPerMetre && pixelsPerMetre > 0 && to > from) {
    let peakIndex = from
    for (let i = from; i <= to; i++) {
      if (Math.abs(velocities[i].vy) > Math.abs(velocities[peakIndex].vy)) peakIndex = i
    }
    for (let i = peakIndex; i <= to; i++) {
      const accelMs2 = accelerationAt(velocities, i, 0.075) / pixelsPerMetre
      if (accelMs2 >= GRAVITY_MS2) {
        propulsiveEnd = i
        break
      }
    }
  }
  const propulsiveSpeeds = velocities.slice(from, propulsiveEnd + 1).map((v) => Math.abs(v.vy))
  const meanPropulsivePxS = propulsiveSpeeds.length
    ? propulsiveSpeeds.reduce((sum, s) => sum + s, 0) / propulsiveSpeeds.length
    : 0

  return {
    index: rep.index,
    startT: samples[from].t,
    endT: samples[to].t,
    durationMs: Math.round((samples[to].t - samples[from].t) * 1000),
    romPx,
    meanVelocityPxS,
    peakVelocityPxS,
    romM: toMetres(romPx),
    meanVelocity: toMetres(meanVelocityPxS),
    peakVelocity: toMetres(peakVelocityPxS),
    meanPropulsiveVelocity: toMetres(meanPropulsivePxS),
    propulsiveFraction:
      pixelsPerMetre && pixelsPerMetre > 0 && speeds.length
        ? propulsiveSpeeds.length / speeds.length
        : null,
  }
}

/** The scale reference: a line drawn across a plate of known diameter. */
export interface CalibrationDto {
  a: { x: number; y: number }
  b: { x: number; y: number }
  plateDiameterMm: number
}

/**
 * What the set was, as the coach entered it.
 *
 * Not measurable from the footage and not guessable from it either, but every
 * velocity-based reading needs it: an m/s figure means nothing until you know
 * which lift produced it, and a load-velocity profile needs the load. All three
 * are nullable because a coach who just wants to look at a bar path should not
 * have to fill in a form first.
 */
export interface SetContext {
  /** A `VbtLift` id — kept as a plain string here so this module stays free of
   *  the VBT tables, which import from it. */
  lift: string | null
  loadKg: number | null
  /** The RPE the athlete called, to compare against what the bar says. */
  calledRpe: number | null
}

/** A saved analysis as it travels over HTTP. */
export interface VideoAnalysisDto extends SetContext {
  id: string
  mediaId: string | null
  athleteId: string | null
  athleteName: string | null
  sourceLabel: string
  track: Sample[]
  calibration: CalibrationDto | null
  metrics: RepMetrics[]
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface SaveVideoAnalysisInput extends SetContext {
  mediaId: string | null
  athleteId: string | null
  sourceLabel: string
  track: Sample[]
  calibration: CalibrationDto | null
  metrics: RepMetrics[]
  notes: string | null
}

/** Standard competition and training plate diameters. */
export const PLATE_DIAMETERS_MM = [
  { label: '450 mm — competition', value: 450 },
  { label: '400 mm', value: 400 },
  { label: '350 mm', value: 350 },
  { label: '325 mm', value: 325 },
] as const

/**
 * Pixels per metre, from a plate of known diameter measured on screen.
 *
 * The plate is the reference because it sits IN the plane the bar moves in, so
 * it suffers less perspective distortion than anything else in frame. These
 * numbers are still an approximation from a single 2-D camera and should be
 * presented as such.
 */
export function pixelsPerMetreFromPlate(plateDiameterPx: number, plateDiameterMm: number): number | null {
  if (plateDiameterPx <= 0 || plateDiameterMm <= 0) return null
  return plateDiameterPx / (plateDiameterMm / 1000)
}

/** Every metric for a tracked path, in one call. */
export function analysePath(
  samples: Sample[],
  pixelsPerMetre: number | null,
  options: SegmentOptions = {},
): { velocities: VelocitySample[]; reps: RepMetrics[] } {
  const velocities = verticalVelocity(samples)
  const reps = segmentReps(samples, velocities, options)
  return { velocities, reps: reps.map((r) => repMetrics(r, samples, velocities, pixelsPerMetre)) }
}
