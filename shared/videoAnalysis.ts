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

/** One lifting cycle, as indices into the sample array. */
export interface Rep {
  index: number
  /** The bottom position this rep starts from. */
  startIndex: number
  /** The next bottom, or the last sample for a final incomplete rep. */
  endIndex: number
  /** The top of the lift — end of the concentric half. */
  topIndex: number
}

export interface SegmentOptions {
  /** Below this |vy| the bar counts as stationary, so jitter at a turnaround
   *  is not mistaken for a direction change. Pixels/second. */
  minMovingSpeed?: number
  /** Minimum vertical travel for a cycle to be a rep rather than track noise. */
  minRomPx?: number
}

const SEGMENT_DEFAULTS: Required<SegmentOptions> = {
  minMovingSpeed: 15,
  minRomPx: 20,
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
    if (Math.abs(samples[startIndex].y - samples[topIndex].y) < opts.minRomPx) continue

    reps.push({ index: reps.length, startIndex, endIndex, topIndex })
  }
  return reps
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
  const windowPeak = windowSpeeds.length ? Math.max(...windowSpeeds) : 0
  const movingThreshold = windowPeak * 0.1
  let from = rep.startIndex
  while (from < to && Math.abs(velocities[from].vy) < movingThreshold) from++

  const speeds = velocities.slice(from, to + 1).map((v) => Math.abs(v.vy))
  const meanVelocityPxS = speeds.length
    ? speeds.reduce((sum, s) => sum + s, 0) / speeds.length
    : 0
  const peakVelocityPxS = speeds.length ? Math.max(...speeds) : 0
  // Range of motion is measured from the TRUE bottom, not the trimmed start:
  // how far the bar travelled and how fast it moved are different questions,
  // and the trim only ever removes time, never distance.
  const romPx = Math.abs(samples[rep.startIndex].y - samples[to].y)
  const toMetres = (px: number) => (pixelsPerMetre && pixelsPerMetre > 0 ? px / pixelsPerMetre : null)

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
  }
}

/** The scale reference: a line drawn across a plate of known diameter. */
export interface CalibrationDto {
  a: { x: number; y: number }
  b: { x: number; y: number }
  plateDiameterMm: number
}

/** A saved analysis as it travels over HTTP. */
export interface VideoAnalysisDto {
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

export interface SaveVideoAnalysisInput {
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
