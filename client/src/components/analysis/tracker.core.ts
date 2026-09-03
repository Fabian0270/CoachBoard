// ---------------------------------------------------------------------------
// Bar-path tracking (Feature 11b).
//
// OpenCV is passed IN rather than imported. The worker loads a ~10 MB
// Emscripten bundle with importScripts, which no test runner can do — but
// opencv.js loads fine under plain Node, so injecting it makes the riskiest
// module in the feature unit-testable against synthetic footage. The worker
// (tracker.worker.ts) is then a thin postMessage shell around this.
//
// Method: Lucas-Kanade sparse optical flow on corners inside the plate, taking
// the MEDIAN displacement so a few bad points cannot drag the track. Two things
// keep it honest over a whole lift:
//   - forward-backward validation: track forward, then back, and discard any
//     point that doesn't land where it started. This is what catches points
//     that latched onto the background as the bar passes.
//   - re-seeding when too few survive, so the plate rotating out its original
//     corners doesn't end the track.
//
// The CSRT/KCF trackers a tool like this would normally reach for live in
// opencv_contrib, which the stock opencv.js build does not ship. TrackerMIL IS
// available and is the fallback if this proves too fragile on real footage.
// ---------------------------------------------------------------------------

/** Minimal shape of the opencv.js module this file uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenCv = any

/** One decoded frame, RGBA, as produced by canvas.getImageData. */
export interface Frame {
  /** Presentation time in seconds, from requestVideoFrameCallback's mediaTime.
   *  Phone video is often variable-frame-rate, so timestamps are carried per
   *  frame and never derived from an assumed fps. */
  t: number
  width: number
  height: number
  data: Uint8ClampedArray
}

/** The box the coach drew around the plate on the first frame, in frame pixels. */
export interface Seed {
  x: number
  y: number
  width: number
  height: number
}

/** One tracked bar position. Spacing is irregular by design (see Frame.t). */
export interface Sample {
  t: number
  x: number
  y: number
}

/**
 * Signals for deciding whether a track is trustworthy enough to derive numbers
 * from.
 *
 * READ THIS BEFORE GATING ANYTHING ON THEM: healthy-looking quality does NOT
 * mean the track followed the bar. A box seeded slightly off the plate — onto a
 * window frame or a rack upright behind it — tracks its static target perfectly
 * and reports 100% survival, zero reseeds and never-lost. That exact failure
 * happened during the 11b spike and was invisible in every metric here; only
 * drawing the path over the frame revealed it.
 *
 * So these gate out BAD tracks, they never certify good ones. The overlay the
 * coach can see is the real check, which is why it is a requirement and not
 * decoration.
 */
export interface TrackQuality {
  /** Corners found inside the seed box. Too few means a featureless plate. */
  seededPoints: number
  /** Median fraction of points surviving forward-backward validation per frame. */
  medianSurvivalRate: number
  /** How often the tracker had to re-seed. High means it is barely holding on. */
  reseeds: number
  /** Frame index where tracking gave up, or null if it held to the end. */
  lostAtFrame: number | null
  /** Effective sample rate over the tracked span. */
  effectiveFps: number
}

export interface TrackResult {
  samples: Sample[]
  quality: TrackQuality
}

export interface TrackOptions {
  /** Points below this fraction of the seed count triggers a re-seed. */
  reseedBelow?: number
  /** Max round-trip error in pixels for a point to be trusted. */
  maxForwardBackwardError?: number
  /** Give up when a re-seed cannot find at least this many corners. */
  minPoints?: number
  /**
   * Pyramid levels for the optical flow search. Each level roughly doubles the
   * per-frame displacement that can be captured, so this is the knob to raise
   * if a fast lift filmed close up outruns the search window.
   *
   * Left at 3 because raising it to 4 changed nothing across the whole spike
   * library — the one clip that failed did so because the camera was picked up
   * mid-clip, not because the bar moved too fast. No evidence, no default
   * change; the option is here for when footage actually demands it.
   */
  pyramidLevels?: number
}

const DEFAULTS = {
  reseedBelow: 0.6,
  maxForwardBackwardError: 1.0,
  minPoints: 6,
  pyramidLevels: 3,
}

/**
 * RGBA -> single-channel grey, written straight into an OpenCV Mat.
 *
 * Done by hand rather than via cv.matFromImageData + cvtColor because
 * ImageData does not exist under Node, and this keeps the module usable in both
 * the worker and the test runner with no shims.
 */
function toGrayMat(cv: OpenCv, frame: Frame): OpenCv {
  const mat = new cv.Mat(frame.height, frame.width, cv.CV_8UC1)
  const src = frame.data
  const dst = mat.data
  for (let i = 0, p = 0; p < dst.length; i += 4, p++) {
    // Rec. 601 luma, integer-scaled — matches cvtColor(COLOR_RGBA2GRAY).
    dst[p] = (src[i] * 77 + src[i + 1] * 150 + src[i + 2] * 29) >> 8
  }
  return mat
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Corners inside a box, as an Nx1 CV_32FC2 Mat of absolute frame coordinates. */
function seedCorners(cv: OpenCv, gray: OpenCv, box: Seed, maxCorners: number): OpenCv {
  const mask = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8UC1)
  const x0 = Math.max(0, Math.round(box.x))
  const y0 = Math.max(0, Math.round(box.y))
  const x1 = Math.min(gray.cols, Math.round(box.x + box.width))
  const y1 = Math.min(gray.rows, Math.round(box.y + box.height))
  for (let y = y0; y < y1; y++) {
    mask.data.fill(255, y * gray.cols + x0, y * gray.cols + x1)
  }
  const corners = new cv.Mat()
  // qualityLevel is deliberately low: a rubber plate under gym lighting is not
  // a checkerboard, and demanding strong corners finds nothing at all.
  cv.goodFeaturesToTrack(gray, corners, maxCorners, 0.01, 5, mask, 3)
  mask.delete()
  return corners
}

/**
 * A tracker that consumes frames one at a time.
 *
 * Streaming rather than array-at-once because optical flow only ever compares
 * frame N to frame N-1 — it needs two frames in memory, not the whole clip.
 * Buffering the clip first cost ~330 MB for twenty seconds of 320px RGBA and
 * meant nothing could be drawn until every frame had been read; this way memory
 * is constant however long the video is, and the path can be drawn as it grows.
 */
export interface StreamingTracker {
  /** Feeds one frame, returning the bar position for it, or null once lost. */
  push(frame: Frame): Sample | null
  /** Releases the OpenCV Mats held between frames. Safe to call twice. */
  dispose(): void
  readonly quality: TrackQuality
  readonly samples: Sample[]
}

/**
 * Starts tracking the seeded box from `first`.
 *
 * Frames must arrive in presentation order and share dimensions. Samples are
 * the box CENTRE in frame pixels; converting to metres is the calibration
 * step's job, not this one's.
 */
export function createTracker(
  cv: OpenCv,
  first: Frame,
  seed: Seed,
  options: TrackOptions = {},
): StreamingTracker {
  const opts = { ...DEFAULTS, ...options }
  const maxCorners = 60

  const winSize = new cv.Size(21, 21)
  const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 30, 0.01)
  const maxLevel = opts.pyramidLevels

  let prevGray = toGrayMat(cv, first)
  const box: Seed = { ...seed }
  let prevPts = seedCorners(cv, prevGray, box, maxCorners)
  const seededPoints = prevPts.rows

  /**
   * Offset from the point cloud's median position to the box centre, fixed at
   * seed time and re-established on every re-seed.
   *
   * This is what stops the track drifting. Summing each frame's median
   * displacement is dead reckoning: every frame's small bias is integrated and
   * never corrected, so error grows without bound over a long lift. Anchoring
   * the centre to the points' MEASURED position each frame keeps the estimate
   * absolute — it can be noisy, but it cannot wander.
   */
  const anchor = { dx: 0, dy: 0 }
  const reanchor = (pts: OpenCv) => {
    const xs: number[] = []
    const ys: number[] = []
    for (let p = 0; p < pts.rows; p++) {
      xs.push(pts.data32F[p * 2])
      ys.push(pts.data32F[p * 2 + 1])
    }
    anchor.dx = box.x + box.width / 2 - median(xs)
    anchor.dy = box.y + box.height / 2 - median(ys)
  }
  reanchor(prevPts)

  const samples: Sample[] = [{ t: first.t, x: box.x + box.width / 2, y: box.y + box.height / 2 }]
  const survivalRates: number[] = []
  let reseeds = 0
  let lostAtFrame: number | null = null
  let frameIndex = 0
  let disposed = false

  const scratch: OpenCv[] = []
  const track = (from: OpenCv, to: OpenCv, pts: OpenCv) => {
    const next = new cv.Mat()
    const status = new cv.Mat()
    const err = new cv.Mat()
    cv.calcOpticalFlowPyrLK(from, to, pts, next, status, err, winSize, maxLevel, criteria)
    scratch.push(next, status, err)
    return { next, status }
  }

  const push = (frame: Frame): Sample | null => {
    if (disposed || lostAtFrame !== null) return null
    const i = ++frameIndex

    try {
      const gray = toGrayMat(cv, frame)

      if (prevPts.rows < opts.minPoints) {
        lostAtFrame = i
        gray.delete()
        return null
      }

      const fwd = track(prevGray, gray, prevPts)
      // Track straight back again: a point that does not return to where it
      // started followed something else — usually the background showing
      // through as the bar moves across it.
      const bwd = track(gray, prevGray, fwd.next)

      const dxs: number[] = []
      const dys: number[] = []
      const keptX: number[] = []
      const keptY: number[] = []
      for (let p = 0; p < prevPts.rows; p++) {
        if (fwd.status.data[p] !== 1 || bwd.status.data[p] !== 1) continue
        const ox = prevPts.data32F[p * 2]
        const oy = prevPts.data32F[p * 2 + 1]
        const nx = fwd.next.data32F[p * 2]
        const ny = fwd.next.data32F[p * 2 + 1]
        const bx = bwd.next.data32F[p * 2]
        const by = bwd.next.data32F[p * 2 + 1]
        if (Math.hypot(bx - ox, by - oy) > opts.maxForwardBackwardError) continue
        dxs.push(nx - ox)
        dys.push(ny - oy)
        keptX.push(nx)
        keptY.push(ny)
      }

      survivalRates.push(prevPts.rows > 0 ? keptX.length / prevPts.rows : 0)

      if (keptX.length < opts.minPoints) {
        // Everything came loose at once — re-seed on the current box and see if
        // the plate can be picked up again before declaring the track lost.
        reseeds++
        prevPts.delete()
        prevPts = seedCorners(cv, gray, box, maxCorners)
        if (prevPts.rows < opts.minPoints) {
          lostAtFrame = i
          prevGray.delete()
          prevGray = gray
          return null
        }
        reanchor(prevPts)
        const recovered = { t: frame.t, x: box.x + box.width / 2, y: box.y + box.height / 2 }
        samples.push(recovered)
        prevGray.delete()
        prevGray = gray
        return recovered
      }

      // Absolute, not cumulative: the centre is read off where the points now
      // ARE, plus the fixed seed-time offset. dxs/dys still gate the re-seed
      // decision but never feed the position, so nothing integrates.
      box.x = median(keptX) + anchor.dx - box.width / 2
      box.y = median(keptY) + anchor.dy - box.height / 2
      const sample = { t: frame.t, x: box.x + box.width / 2, y: box.y + box.height / 2 }
      samples.push(sample)

      const survivalRate = keptX.length / prevPts.rows
      prevPts.delete()
      if (survivalRate < opts.reseedBelow) {
        reseeds++
        prevPts = seedCorners(cv, gray, box, maxCorners)
        reanchor(prevPts)
      } else {
        // Carry the surviving points forward rather than re-detecting: it is
        // both cheaper and more stable than fresh corners every frame.
        prevPts = cv.matFromArray(keptX.length, 1, cv.CV_32FC2, interleave(keptX, keptY))
      }

      prevGray.delete()
      prevGray = gray
      return sample
    } finally {
      // Per-frame scratch Mats. Released every frame rather than at the end,
      // because "at the end" is unbounded when frames stream in.
      for (const m of scratch) m.delete()
      scratch.length = 0
    }
  }

  return {
    push,
    dispose() {
      if (disposed) return
      disposed = true
      for (const m of scratch) m.delete()
      scratch.length = 0
      prevPts.delete()
      prevGray.delete()
    },
    samples,
    get quality(): TrackQuality {
      const span = samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0
      return {
        seededPoints,
        medianSurvivalRate: median(survivalRates),
        reseeds,
        lostAtFrame,
        effectiveFps: span > 0 ? (samples.length - 1) / span : 0,
      }
    },
  }
}

/**
 * Tracks a complete array of frames in one call.
 *
 * A thin wrapper over the streaming tracker, kept because it is far easier to
 * assert against in tests — the production path streams.
 */
export function trackFrames(
  cv: OpenCv,
  frames: Frame[],
  seed: Seed,
  options: TrackOptions = {},
): TrackResult {
  if (frames.length === 0) {
    return {
      samples: [],
      quality: { seededPoints: 0, medianSurvivalRate: 0, reseeds: 0, lostAtFrame: null, effectiveFps: 0 },
    }
  }
  if (frames.length < 2) {
    return {
      samples: frames.map((f) => ({ t: f.t, x: seed.x + seed.width / 2, y: seed.y + seed.height / 2 })),
      quality: { seededPoints: 0, medianSurvivalRate: 0, reseeds: 0, lostAtFrame: null, effectiveFps: 0 },
    }
  }

  const tracker = createTracker(cv, frames[0], seed, options)
  try {
    for (let i = 1; i < frames.length; i++) {
      if (tracker.push(frames[i]) === null) break
    }
    return { samples: tracker.samples, quality: tracker.quality }
  } finally {
    tracker.dispose()
  }
}

function interleave(xs: number[], ys: number[]): number[] {
  const out = new Array<number>(xs.length * 2)
  for (let i = 0; i < xs.length; i++) {
    out[i * 2] = xs[i]
    out[i * 2 + 1] = ys[i]
  }
  return out
}
