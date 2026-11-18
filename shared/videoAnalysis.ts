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

  // Samples are in time order, so each one's window is a contiguous slice that
  // only ever moves forward. This used to scan the WHOLE track for every
  // sample — measured at 2.4 s for a ten-minute track and 8.5 s at the frame
  // cap, on the UI thread, re-run on every calibration click.
  let lo = 0
  let hi = 0
  return samples.map((s, i) => {
    let sw = 0, swx = 0, swx2 = 0, swx3 = 0, swx4 = 0, swy = 0, swxy = 0, swx2y = 0
    let count = 0

    while (lo < samples.length && s.t - samples[lo].t > half) lo++
    if (hi < lo) hi = lo
    while (hi < samples.length && samples[hi].t - s.t <= half) hi++

    for (let k = lo; k < hi; k++) {
      const p = samples[k]
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

  // Walk outwards from the centre rather than over the whole track: velocities
  // are in time order, so the window is the contiguous run around `index`.
  let lo = index
  let hi = index
  while (lo > 0 && centre.t - velocities[lo - 1].t <= halfWindowS) lo--
  while (hi < velocities.length - 1 && velocities[hi + 1].t - centre.t <= halfWindowS) hi++
  for (let k = lo; k <= hi; k++) {
    const p = velocities[k]
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
  /**
   * Minimum travel as a fraction of the set's LARGEST rep.
   *
   * The median rule above fails exactly when phantoms outnumber real reps: a
   * single squat with a walkout sway either side has a median that IS a sway,
   * so the sways passed — and the last one, at 0.06 m/s, became the "last rep"
   * every RPE reading and the 1RM-velocity offer are taken from. A quarter of
   * the largest drops them while a genuine partial rep, or a failed one that
   * got halfway, stays; a tracker glitch would have to be four times a real
   * rep's travel before it could hide one.
   */
  minRomFractionOfLargest?: number
}

const SEGMENT_DEFAULTS: Required<SegmentOptions> = {
  minMovingSpeed: 15,
  minRomPx: 20,
  minRomFraction: 0.4,
  minRomFractionOfLargest: 0.25,
}

/**
 * The shortest bar travel that counts as a rep once the path is calibrated.
 *
 * Shorter than any barbell lift's real range — a board press still moves the
 * bar about 10 cm — and longer than a walkout sway or a re-rack bounce, which
 * is what a pixel floor alone cannot say, since pixels depend on the zoom.
 */
export const MIN_REP_ROM_M = 0.07

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
  const roms = reps.map((r) => r.romPx)
  const floor = Math.max(
    median(roms) * opts.minRomFraction,
    Math.max(...roms) * opts.minRomFractionOfLargest,
  )
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
  // Displacement over time, which is what "mean concentric velocity" means.
  // This used to average the velocity SAMPLES, which weights each moment by
  // how many frames happened to land in it — and frames are dropped unevenly
  // under load. Measured: drops clustered in the fast middle of a squat read
  // 0.322 m/s against a true 0.383.
  const meanVelocityPxS = displacementRate(samples, from, to)
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
  // Same definition as the mean above, over the propulsive span only.
  const meanPropulsivePxS = displacementRate(samples, from, propulsiveEnd)

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

/** How far the bar moved sideways during one rep's concentric (BP8). */
export interface RepDrift {
  /** Furthest from the vertical line through the bottom, either side. */
  maxPx: number
  /** Where the top ended up against the bottom: positive is right in the picture. */
  netPx: number
  maxM: number | null
  netM: number | null
}

/**
 * Sideways travel during a rep's concentric, read from the tracked path between
 * its start and its top.
 *
 * Worked out from the path rather than stored with the rep, so every saved set
 * has it, including those saved before it existed. The start is the trimmed
 * one (see repMetrics), which only drops time standing still at the bottom,
 * so the bar is where the bottom left it. Null when the path has fewer than two
 * samples in the rep.
 */
export function repDrift(track: Sample[], rep: { startT: number; endT: number }, pixelsPerMetre: number | null): RepDrift | null {
  const inRep = track.filter((s) => s.t >= rep.startT - 1e-6 && s.t <= rep.endT + 1e-6)
  if (inRep.length < 2) return null
  const x0 = inRep[0].x
  let maxPx = 0
  for (const s of inRep) maxPx = Math.max(maxPx, Math.abs(s.x - x0))
  const netPx = inRep[inRep.length - 1].x - x0
  const toM = (px: number) => (pixelsPerMetre && pixelsPerMetre > 0 ? px / pixelsPerMetre : null)
  return { maxPx, netPx, maxM: toM(maxPx), netM: toM(netPx) }
}

/**
 * A dip has to be at least this deep, as a fraction of the stretch's top speed,
 * to be a sticking point rather than tracking noise.
 */
const STICKING_MIN_DIP = 0.1

/**
 * The deepest slow-down in one stretch of upward speeds: the sample furthest
 * below the fastest point on BOTH sides of it. A stretch that only speeds up and
 * then slows down has none. Shared by the skeleton chart's sticking point
 * (`stickingPoint` in pose.ts) and the per-rep one below.
 */
export function deepestDip(run: number[]): { index: number; depth: number } | null {
  if (run.length < 3) return null
  const top = Math.max(...run)
  if (!(top > 0)) return null
  const before: number[] = []
  for (let k = 0, m = 0; k < run.length; k++) before.push((m = Math.max(m, run[k])))
  const after: number[] = new Array(run.length)
  for (let k = run.length - 1, m = 0; k >= 0; k--) after[k] = m = Math.max(m, run[k])
  let best: { index: number; depth: number } | null = null
  for (let k = 1; k < run.length - 1; k++) {
    const depth = Math.min(before[k], after[k]) - run[k]
    if (depth >= top * STICKING_MIN_DIP && (!best || depth > best.depth)) best = { index: k, depth }
  }
  return best
}

export interface RepStickingPoint {
  t: number
  /** Upward bar speed there, px/s. */
  speedPxS: number
  /** How far up the rep it happened: 0 at the bottom, 1 at the top. */
  height: number
}

/**
 * Where each rep slowed most on the way up (BP11), or null for a rep that
 * never did. One per rep, in the order given.
 *
 * The rep's whole way up is one stretch here, rather than being split into
 * runs of upward motion the way the skeleton chart does: a bar that stalls
 * dead mid-rep has speed 0 at the stall, and splitting there would lose the
 * one sticking point that matters most. The pause at the bottom and the
 * slow-down into lockout are never dips — nothing faster comes before or
 * after them.
 *
 * Worked out from the stored track, so sets saved before this exist get it too.
 */
export function repStickingPoints(track: Sample[], reps: { startT: number; endT: number }[]): (RepStickingPoint | null)[] {
  const velocities = verticalVelocity(track)
  return reps.map((rep) => {
    const idx: number[] = []
    track.forEach((s, i) => { if (s.t >= rep.startT - 1e-6 && s.t <= rep.endT + 1e-6) idx.push(i) })
    if (idx.length < 3) return null
    const up = idx.map((i) => Math.max(0, -velocities[i].vy))
    const dip = deepestDip(up)
    if (!dip) return null
    const bottom = track[idx[0]].y
    const range = bottom - track[idx[idx.length - 1]].y
    if (!(range > 0)) return null
    const at = idx[dip.index]
    return {
      t: track[at].t,
      speedPxS: up[dip.index],
      height: Math.min(1, Math.max(0, (bottom - track[at].y) / range)),
    }
  })
}

/** A rep's tempo (BP12): how long the way down took, and the pause at the bottom. No lockout time (D36). */
export interface RepTempo {
  descentMs: number
  /** From arriving at the bottom to moving up again; 0 for touch-and-go. */
  pauseMs: number
}

/**
 * Each rep's descent and pause, in the order given, worked out from the
 * stored track like the sideways drift, so older sets get it too.
 *
 * Walked BACK from where the rep starts up (`startT`, already past the pause
 * — see the trim in repMetrics): samples not moving down are the pause, the
 * run moving down before them is the descent. "Moving down" is the same rule
 * as the trim, a tenth of the descent's own top speed, so it holds at any zoom.
 * The search stops at the top before the rep (the previous rep's end, or the
 * start of the path for the first). Null when there is no descent there — the
 * first pull of a deadlift starts on the floor — or it covers under a quarter
 * of the rep's range, which is a wobble, not the way down.
 */
export function repTempos(track: Sample[], reps: { startT: number; endT: number; romPx: number }[]): (RepTempo | null)[] {
  if (track.length < 3) return reps.map(() => null)
  const velocities = verticalVelocity(track)
  const indexAt = (t: number) => {
    const i = track.findIndex((s) => s.t >= t - 1e-6)
    return i === -1 ? track.length - 1 : i
  }
  const order = reps.map((_, i) => i).sort((a, b) => reps[a].startT - reps[b].startT)
  const result: (RepTempo | null)[] = reps.map(() => null)
  order.forEach((ri, k) => {
    const rep = reps[ri]
    const lower = k === 0 ? 0 : indexAt(reps[order[k - 1]].endT)
    const up = indexAt(rep.startT)
    if (up - lower < 3) return
    const down = velocities.slice(lower, up + 1).map((v) => v.vy).filter((vy) => vy > 0)
    if (down.length < 2) return
    const moving = percentile(down, PEAK_PERCENTILE) * 0.1
    let arrive = up - 1
    while (arrive > lower && velocities[arrive].vy < moving) arrive--
    if (arrive <= lower) return
    let top = arrive
    while (top > lower && velocities[top].vy >= moving) top--
    if (track[arrive].y - track[top].y < rep.romPx * 0.25) return
    result[ri] = {
      descentMs: Math.round((track[arrive].t - track[top].t) * 1000),
      pauseMs: Math.max(0, Math.round((rep.startT - track[arrive].t) * 1000)),
    }
  })
  return result
}

/** Vertical distance over elapsed time between two samples, px/s. 0 for no time. */
function displacementRate(samples: Sample[], from: number, to: number): number {
  const dt = samples[to].t - samples[from].t
  return dt > 0 ? Math.abs(samples[from].y - samples[to].y) / dt : 0
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
  /** Which velocity the set was read from ('mean' | 'peak' | 'propulsive').
   *  Null follows the lift's default — see defaultVelocityMetric. Stored so a
   *  reopened analysis cannot report the same set differently from the page it
   *  was tracked on. */
  metric: string | null
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
  /** True when the analysis can be replayed — from its own stored copy, or from
   *  the Discord clip it references. False means only the path survives. */
  hasVideo: boolean
  createdAt: string
  updatedAt: string
  /**
   * When the set was lifted, as near as the app knows: a synced clip's posting
   * time, else when it was saved. What sessions are grouped by (BP33).
   */
  liftedAt: string
  /** The training day, and the row of it, this set was (L2). Null when not
   *  linked, or when the day has since been deleted. */
  link: AnalysisLink | null
}

/** Where in a program a saved set belongs (L2, D67). */
export interface AnalysisLink {
  workoutId: string
  date: string | null
  workoutName: string
  programId: string
  programName: string
  /** Null: linked to the day only, or the row has since been deleted. */
  exerciseId: string | null
  exerciseName: string | null
}

/** A row of a day a set could be linked to. */
export interface AnalysisLinkRow {
  exerciseId: string
  name: string
  sets: string | null
  reps: string | null
  /** The planned load (Load Cap). */
  weight: number | null
  loadUsed: string | null
  /** The lift matches the set's, and the load agrees when there is one. */
  fits: boolean
}

/** A training day near when the set was lifted, for the link pickers. */
export interface AnalysisLinkDay {
  workoutId: string
  date: string | null
  workoutName: string
  programId: string
  programName: string
  rows: AnalysisLinkRow[]
  /** The one row that fits, when exactly one does — picked for the coach. */
  suggestedExerciseId: string | null
}

export interface SaveVideoAnalysisInput extends SetContext {
  mediaId: string | null
  athleteId: string | null
  sourceLabel: string
  track: Sample[]
  calibration: CalibrationDto | null
  metrics: RepMetrics[]
  notes: string | null
  /** Relative path of an already-uploaded copy, from POST /api/analysis/video.
   *  Null for a Discord clip, which needs no copy. */
  videoPath?: string | null
  videoBytes?: number | null
  /** The training day and row (L2); both optional. */
  workoutId?: string | null
  exerciseId?: string | null
}

/**
 * Plate diameters to calibrate against, largest first.
 *
 * Named by the plate the coach is looking at rather than by a bare number,
 * because picking the wrong one silently rescales every reading downstream and
 * "450 mm" is not what anyone sees when they look at a loaded bar.
 *
 * The useful fact for powerlifting: an IPF 25 kg and an IPF 20 kg are BOTH
 * 450 mm. They differ in thickness, not diameter (the Technical Rulebook caps
 * the largest disc at 450 mm), so the biggest disc on a competition bar is
 * 450 mm whichever of the two it is — and the biggest disc is the one whose
 * edge is visible to click. Standard training bumpers are also 450 mm.
 *
 * Verified against Eleiko's IPF competition plate data sheets. The smaller
 * competition discs are deliberately absent: their diameters could not be
 * verified from a primary source, and they are never the outermost silhouette
 * on a loaded bar anyway, so they are not what a coach would measure across.
 */
export const PLATE_DIAMETERS_MM = [
  { label: '450 mm — IPF 25 kg or 20 kg, or a standard bumper', value: 450 },
  { label: '400 mm — smaller bumper', value: 400 },
  { label: '350 mm — training plate', value: 350 },
  { label: '325 mm — training plate', value: 325 },
] as const

/** A saved analysis's scale, from its stored line across the plate; null without one. */
export function analysisPixelsPerMetre(analysis: { calibration: CalibrationDto | null }): number | null {
  const c = analysis.calibration
  if (!c) return null
  return pixelsPerMetreFromPlate(Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y), c.plateDiameterMm)
}

/** Where the picture actually sits inside a video element's box, in CSS pixels. */
export interface PictureRect {
  left: number
  top: number
  width: number
  height: number
  /** Display pixels per video pixel. */
  scale: number
}

/**
 * The letterboxed picture inside a `<video>` element.
 *
 * A video element paints with `object-fit: contain`, so the picture only fills
 * the whole element when their aspect ratios happen to match. Normally the
 * difference is invisible, because the stage sizes the element to the clip. In
 * FULLSCREEN it is not: the element becomes the whole screen and a portrait lift
 * gets wide black bars either side.
 *
 * That matters because the overlay is drawn in display pixels derived from the
 * element's own rect. Taking `rect.width / videoWidth` as the scale silently
 * assumes no letterboxing, so in fullscreen every drawn point stretches and
 * shifts — the path drifts off the bar, which reads as a tracking failure rather
 * than a display bug. Same arithmetic in reverse for mapping a click back.
 */
export function pictureRect(
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
): PictureRect {
  if (!(videoWidth > 0) || !(videoHeight > 0) || !(elementWidth > 0) || !(elementHeight > 0)) {
    return { left: 0, top: 0, width: elementWidth, height: elementHeight, scale: 1 }
  }
  // contain: whichever axis runs out first decides the scale.
  const scale = Math.min(elementWidth / videoWidth, elementHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
    scale,
  }
}

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
  // With a scale, the noise floor can be a real distance instead of pixels.
  const calibratedFloor =
    pixelsPerMetre && pixelsPerMetre > 0 ? MIN_REP_ROM_M * pixelsPerMetre : 0
  const reps = segmentReps(samples, velocities, {
    ...options,
    minRomPx: Math.max(options.minRomPx ?? SEGMENT_DEFAULTS.minRomPx, calibratedFloor),
  })
  return { velocities, reps: reps.map((r) => repMetrics(r, samples, velocities, pixelsPerMetre)) }
}
