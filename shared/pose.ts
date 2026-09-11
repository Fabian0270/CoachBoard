// ---------------------------------------------------------------------------
// Pose landmarks and joint angles (Feature 11e).
//
// Pure functions over a pose track — no I/O, no DOM, no MediaPipe. Same "math as
// data" shape as videoAnalysis.ts next door, and for the same reason: this half
// is testable under the node-only test runner while the inference it describes
// can only run in a browser worker.
//
// The bar path says where the bar went and nothing about the body that moved it.
// This is the other half — the knee angle at the sticking point, whether the
// hips shot up first — and it has to line up with the bar path exactly, which
// drives the two conventions below.
//
// COORDINATES ARE ORIGINAL VIDEO PIXELS, and `y` grows DOWNWARD, identical to
// `Sample` in videoAnalysis.ts. MediaPipe hands back 0-1 normalised against
// whatever it was fed, which is a downscaled frame; leaving landmarks in that
// space would mean nothing lines up with the bar path and every angle silently
// depends on the capture width. Convert on the way out — `toVideoPixels` below.
//
// VISIBILITY IS NEVER IGNORED. A loaded bar with 450 mm plates occludes the hip
// from a side view and a rack upright crosses the limbs. The model reports what
// it cannot see, and this module's rule is the one the tracker already follows
// one level up: rule readings OUT, never certify them in. A confident wrong knee
// angle is worse than no number, because nothing about it looks wrong.
// ---------------------------------------------------------------------------

/**
 * The 33 landmarks MediaPipe Pose returns, by index.
 *
 * Only the ones this app has a use for are named. The heel and foot-index points
 * are why the 33-landmark model was chosen over a 17-point COCO one: ankle angle
 * and squat depth relative to the foot cannot be computed without them.
 */
export const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const

export const LANDMARK_COUNT = 33

/**
 * Bones to draw, as landmark index pairs.
 *
 * Defined here rather than imported from MediaPipe's `POSE_CONNECTIONS` so that
 * nothing outside the worker has to depend on the library — `shared/` is also
 * loaded by the server, which has no business pulling in a vision runtime. The
 * face mesh is deliberately omitted: a coach is looking at a lift, and drawing
 * eleven landmarks around the nose only adds clutter over the lifter's head.
 */
export const POSE_BONES: readonly (readonly [number, number])[] = [
  // Torso
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
  [LM.LEFT_SHOULDER, LM.LEFT_HIP],
  [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.RIGHT_HIP],
  // Arms
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
  [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
  [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  // Legs
  [LM.LEFT_HIP, LM.LEFT_KNEE],
  [LM.LEFT_KNEE, LM.LEFT_ANKLE],
  [LM.RIGHT_HIP, LM.RIGHT_KNEE],
  [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
  // Feet — the reason for a 33-point model
  [LM.LEFT_ANKLE, LM.LEFT_HEEL],
  [LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX],
  [LM.LEFT_ANKLE, LM.LEFT_FOOT_INDEX],
  [LM.RIGHT_ANKLE, LM.RIGHT_HEEL],
  [LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX],
  [LM.RIGHT_ANKLE, LM.RIGHT_FOOT_INDEX],
] as const

/** One landmark, in ORIGINAL VIDEO PIXELS. See the header. */
export interface Landmark {
  x: number
  y: number
  /**
   * Depth, and usually absent.
   *
   * The drawing landmarks are flat by construction — they are pixels on a
   * frame. It is the WORLD landmarks (see PoseFrame.world) that carry a real z,
   * and the angle maths below treats a missing z as 0 so one implementation
   * serves both.
   */
  z?: number
  /** The model's own 0-1 confidence that this joint is actually visible. */
  visibility: number
}

/** Every landmark for one frame, timestamped the way a bar-path Sample is. */
export interface PoseFrame {
  /** mediaTime in seconds — the same clock the bar path uses. */
  t: number
  /** Image-space, ORIGINAL VIDEO PIXELS. What the overlay draws. */
  landmarks: Landmark[]
  /**
   * The same joints in 3D METRES, hip-centred and camera-independent.
   *
   * ANGLES ARE MEASURED FROM THESE, NOT FROM THE PIXELS. A joint angle is a
   * property of the body, but its projection onto the image plane is a property
   * of where the camera happened to be standing — and the two only agree when
   * the lift is filmed square-on to the plane the joint moves in.
   *
   * That assumption broke on the first real clip. A squat filmed FROM THE FRONT
   * bends the knee almost directly toward the lens, so in pixels the hip, knee
   * and ankle stay nearly in line and the angle reads close to straight at full
   * depth — confidently, with no symptom. The world landmarks have the depth the
   * projection threw away, so they give the same answer whichever side the phone
   * was propped on.
   *
   * Optional because a track stored before this existed has none, and because
   * the overlay does not need them.
   */
  world?: Landmark[]
}

/**
 * Below this the model is guessing, and a guess drawn confidently is the failure
 * this feature has to avoid.
 *
 * 0.5 is MediaPipe's own convention. Landmarks under it are still carried
 * through — the overlay greys them rather than dropping them, so a coach can see
 * that the model lost the hip rather than wondering why the leg vanished — but
 * no derived number is computed from them.
 */
export const MIN_VISIBILITY = 0.5

export const isVisible = (l: Landmark | undefined): l is Landmark =>
  l != null && l.visibility >= MIN_VISIBILITY

/**
 * MediaPipe's normalised output -> original video pixels.
 *
 * The model is fed a downscaled frame and normalises against THAT, so the only
 * thing needed to get back to video pixels is the video's own dimensions — the
 * capture width cancels out. This is what keeps a pose track comparable with a
 * bar path tracked at a different scale, and re-runnable at a different capture
 * width without invalidating anything already stored.
 */
export function toVideoPixels(
  normalised: { x: number; y: number; visibility?: number }[],
  videoWidth: number,
  videoHeight: number,
): Landmark[] {
  return normalised.map((l) => ({
    x: l.x * videoWidth,
    y: l.y * videoHeight,
    visibility: l.visibility ?? 0,
  }))
}

/**
 * The angle at `b`, in degrees, formed by the segments b->a and b->c.
 *
 * Always the 0-180 interior angle, because that is what a joint has: a knee at
 * "340 degrees" is the same knee as one at 20, and letting the sign flip with
 * camera side would make left and right legs incomparable. A straight leg is
 * 180 and a fully closed one approaches 0.
 *
 * Returns null rather than a number when any point is missing or two of them
 * coincide — an angle at a zero-length segment is undefined, and NaN propagating
 * into a chart is how a nonsense reading gets drawn as if it were real.
 */
export function jointAngle(
  a: Landmark | undefined,
  b: Landmark | undefined,
  c: Landmark | undefined,
): number | null {
  if (!a || !b || !c) return null
  const abx = a.x - b.x
  const aby = a.y - b.y
  // Absent on the image-space landmarks, real on the world ones. Treating it as
  // zero makes this one function correct for both: a flat landmark set is just
  // a 3D one that happens to lie in a plane.
  const abz = (a.z ?? 0) - (b.z ?? 0)
  const cbx = c.x - b.x
  const cby = c.y - b.y
  const cbz = (c.z ?? 0) - (b.z ?? 0)

  const magAb = Math.hypot(abx, aby, abz)
  const magCb = Math.hypot(cbx, cby, cbz)
  if (magAb === 0 || magCb === 0) return null

  // Clamped because floating-point error can push a straight limb's cosine a
  // hair past ±1, and Math.acos returns NaN there rather than 0 or 180.
  const dot = abx * cbx + aby * cby + abz * cbz
  const cos = Math.min(1, Math.max(-1, dot / (magAb * magCb)))
  return (Math.acos(cos) * 180) / Math.PI
}

/** Same as jointAngle, but refuses to answer from landmarks the model could not see. */
export function visibleJointAngle(
  a: Landmark | undefined,
  b: Landmark | undefined,
  c: Landmark | undefined,
): number | null {
  if (!isVisible(a) || !isVisible(b) || !isVisible(c)) return null
  return jointAngle(a, b, c)
}

/** Which side of the body a reading came from. */
export type Side = 'left' | 'right'

/**
 * The side the camera can actually see.
 *
 * Lifting footage is filmed side-on, so one half of the body is nearer the lens
 * and the other is behind the torso with the model half-guessing at it. Picking
 * per clip rather than averaging the two matters: on a side-on squat the far
 * knee routinely reads several degrees off, and folding that into the near
 * knee's number quietly corrupts the one good reading.
 *
 * Decided by summed visibility over the joints the angles below are built from,
 * across the whole track rather than per frame — a side that flickers frame to
 * frame would make every derived series discontinuous.
 */
export function cameraSide(frames: PoseFrame[]): Side {
  let left = 0
  let right = 0
  for (const frame of frames) {
    for (const i of [LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE]) {
      left += frame.landmarks[i]?.visibility ?? 0
    }
    for (const i of [LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE]) {
      right += frame.landmarks[i]?.visibility ?? 0
    }
  }
  // Ties go to the left, arbitrarily but deterministically — a coin flip here
  // would make the same clip read differently on two openings.
  return right > left ? 'right' : 'left'
}

/** The landmark indices for one side, so the angle helpers read the same either way. */
export function sideJoints(side: Side) {
  return side === 'left'
    ? {
        shoulder: LM.LEFT_SHOULDER,
        hip: LM.LEFT_HIP,
        knee: LM.LEFT_KNEE,
        ankle: LM.LEFT_ANKLE,
        foot: LM.LEFT_FOOT_INDEX,
      }
    : {
        shoulder: LM.RIGHT_SHOULDER,
        hip: LM.RIGHT_HIP,
        knee: LM.RIGHT_KNEE,
        ankle: LM.RIGHT_ANKLE,
        foot: LM.RIGHT_FOOT_INDEX,
      }
}

/** The joint angles worth reading off a lift, for one frame. Null where unseen. */
export interface FrameAngles {
  t: number
  /** Straight leg 180, deep squat well under 90. */
  knee: number | null
  /** Shoulder-hip-knee. Closes as the lifter folds forward. */
  hip: number | null
  /** Knee-ankle-foot. Needs the foot index, hence the 33-point model. */
  ankle: number | null
  /**
   * Torso lean from vertical, in degrees. 0 is upright, 90 is horizontal.
   *
   * Not a joint angle — measured against gravity rather than a third landmark —
   * but it answers "did the hips shoot up first", which is the question a coach
   * actually asks of a squat, and it belongs on the same axis as the rest.
   */
  torsoLean: number | null
  /**
   * False when this frame had no world landmarks and the angles above were read
   * off the pixels instead.
   *
   * Carried per frame rather than assumed, because a flat reading is only
   * trustworthy when the lift was filmed square to the plane it moves in — and
   * on a front-on squat it is confidently wrong. Anything charting these should
   * say so rather than drawing both kinds as one line.
   */
  metric: boolean
}

/**
 * Every angle for every frame.
 *
 * Read from the WORLD landmarks where the frame has them — see PoseFrame.world
 * for why the pixels are not good enough. `side` still selects which limb, since
 * even in 3D the far leg is the one the model is guessing hardest at.
 */
export function frameAngles(frames: PoseFrame[], side: Side = cameraSide(frames)): FrameAngles[] {
  const j = sideJoints(side)
  return frames.map((frame) => {
    // Visibility lives on the image landmarks — the world set carries the same
    // joints but is the model's metric estimate, so occlusion is judged on what
    // the camera could actually see and the geometry is taken from the 3D.
    const seen = (i: number) => frame.landmarks[i]
    const measured = frame.world ?? frame.landmarks
    const at = (i: number): Landmark | undefined => {
      const l = measured[i]
      // Gate on the image-space confidence, then hand back the metric point.
      return l && isVisible(seen(i)) ? l : undefined
    }

    const shoulder = at(j.shoulder)
    const hip = at(j.hip)
    return {
      t: frame.t,
      knee: jointAngle(hip, at(j.knee), at(j.ankle)),
      hip: jointAngle(shoulder, hip, at(j.knee)),
      ankle: jointAngle(at(j.knee), at(j.ankle), at(j.foot)),
      torsoLean:
        shoulder && hip
          ? // atan2 of the horizontal run over the vertical rise, so the answer
            // is lean from vertical regardless of which way the lifter faces.
            //
            // This one depends on y pointing DOWN, and unlike the joint angles
            // above it cannot absorb the difference. A joint angle is measured
            // between two segments, so flipping the y axis leaves it unchanged;
            // this is measured against a fixed axis, so a flip turns θ into
            // 180 − θ and an upright lifter would read 90+ instead of 0.
            //
            // MediaPipe's WORLD landmarks keep the image convention — x right,
            // y down, z toward the camera, in metres from the hip midpoint — so
            // both bases agree and one expression serves them. An earlier
            // comment here claimed world space was y-up and that the absolute
            // value made it moot; both halves were wrong, and only the fact that
            // the premise was false kept the result correct. See the
            // world-space test in pose.test.ts, which pins it.
            Math.abs((Math.atan2(hip.x - shoulder.x, hip.y - shoulder.y) * 180) / Math.PI)
          : null,
      metric: frame.world != null,
    }
  })
}

/**
 * Median filter over a landmark series, in frames.
 *
 * Median rather than mean on purpose. Pose jitter is not gaussian noise around
 * the truth — it is the occasional frame where a joint snaps somewhere else
 * entirely, which is exactly what a mean drags the whole window toward and a
 * median ignores. Same instinct as `looksMistracked` on the bar path.
 *
 * An even window is widened by one so there is always a true middle element.
 * Visibility is carried from the centre frame untouched: smoothing a confidence
 * would invent confidence the model never reported.
 *
 * The WORLD landmarks are filtered alongside the image ones and, critically, are
 * carried through. Dropping them (which this used to do) would look harmless and
 * silently switch every joint angle to the image-space basis — the one the
 * header explains is confidently wrong on front-on footage, where a deep squat
 * reads as nearly straight legs. Visibility still gates the vote in BOTH sets,
 * judged on the image-space confidence, because that is the only place the model
 * reports what it could actually see.
 *
 * Note x and y are filtered independently, so an output point may be a pair that
 * appeared in no single frame. That is ordinary for a separable median filter
 * and is what makes it reject a snap, but it does mean the result is a
 * reconstruction rather than a measurement — which is why the caller smooths for
 * DISPLAY and stores the raw track.
 */
export function smooth(frames: PoseFrame[], window = 5): PoseFrame[] {
  if (window <= 1 || frames.length === 0) return frames
  const span = window % 2 === 0 ? window + 1 : window
  const half = Math.floor(span / 2)

  const medianOf = (values: number[]): number => {
    values.sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  }

  return frames.map((frame, i) => {
    const from = Math.max(0, i - half)
    const to = Math.min(frames.length - 1, i + half)

    const landmarks = frame.landmarks.map((centre, lm) => {
      const xs: number[] = []
      const ys: number[] = []
      for (let f = from; f <= to; f++) {
        const l = frames[f].landmarks[lm]
        // Only frames where the model could see the joint get a vote. Averaging
        // in a position it was guessing at is how a good frame gets dragged
        // toward a bad one.
        if (isVisible(l)) {
          xs.push(l.x)
          ys.push(l.y)
        }
      }
      if (xs.length === 0) return centre
      return { x: medianOf(xs), y: medianOf(ys), visibility: centre.visibility }
    })

    // Only when this frame has them. A partial world set is worse than none —
    // see packPose — so a frame without one stays without one.
    const world = frame.world?.map((centre, lm) => {
      const xs: number[] = []
      const ys: number[] = []
      const zs: number[] = []
      for (let f = from; f <= to; f++) {
        const w = frames[f].world?.[lm]
        // Gated on the IMAGE landmark's visibility, matching frameAngles: the
        // world set carries the model's estimate whether or not it could see the
        // joint, so occlusion is only knowable from the image side.
        if (w && isVisible(frames[f].landmarks[lm])) {
          xs.push(w.x)
          ys.push(w.y)
          zs.push(w.z ?? 0)
        }
      }
      if (xs.length === 0) return centre
      return { x: medianOf(xs), y: medianOf(ys), z: medianOf(zs), visibility: centre.visibility }
    })

    return world ? { t: frame.t, landmarks, world } : { t: frame.t, landmarks }
  })
}

// ---------------------------------------------------------------------------
// Against the bar (11e-6)
// ---------------------------------------------------------------------------
//
// The actual coaching payoff, and the reason the phases before it were built the
// way they were: pose and the bar path already share a coordinate space and a
// clock, so putting them on one x-axis needs no alignment step.

/** One instant, with what the body was doing and what the bar was doing. */
export interface AngleVsBar {
  t: number
  knee: number | null
  hip: number | null
  ankle: number | null
  torsoLean: number | null
  /** Signed vertical bar velocity, m/s if calibrated, px/s if not. Negative = up. */
  barVelocity: number | null
  metric: boolean
}

/**
 * Joins per-frame angles to the bar's velocity on a shared time axis.
 *
 * Pose frames drive the series rather than velocity samples: there are fewer of
 * them (inference drops frames the tracker keeps) and interpolating angles would
 * invent body positions that were never measured. Bar velocity is sampled at the
 * nearest velocity reading instead, which is a real measurement at a real time.
 *
 * `maxGapS` refuses a join that would be a lie — a pose frame with no velocity
 * sample anywhere near it gets null rather than the nearest one half a second
 * away. Default is a generous two frames at 30 fps.
 */
export function anglesAgainstBar(
  angles: FrameAngles[],
  velocities: { t: number; vy: number }[],
  maxGapS = 0.067,
): AngleVsBar[] {
  if (velocities.length === 0) {
    return angles.map((a) => ({ ...a, barVelocity: null }))
  }

  // Both series are in time order, so this walks rather than searching: the
  // pointer only ever moves forward across the whole join.
  let v = 0
  return angles.map((a) => {
    while (v < velocities.length - 1 && Math.abs(velocities[v + 1].t - a.t) <= Math.abs(velocities[v].t - a.t)) {
      v++
    }
    const nearest = velocities[v]
    return {
      ...a,
      barVelocity: Math.abs(nearest.t - a.t) <= maxGapS ? nearest.vy : null,
    }
  })
}

/**
 * Where the bar was slowest during the concentric — the sticking point.
 *
 * Returned as an index into the joined series so a caller can read every angle
 * at that instant, which is the whole question: what was the knee doing when the
 * bar stopped moving.
 *
 * Concentric only, hence the negative-velocity filter — `vy` is image space, so
 * up is negative. The slowest moment of a descent is not a sticking point, it is
 * the turnaround, and reporting that as one would be worse than saying nothing.
 */
export function stickingPoint(series: AngleVsBar[]): number | null {
  let best: number | null = null
  for (let i = 0; i < series.length; i++) {
    const v = series[i].barVelocity
    // Strictly rising: a bar at rest is not in a sticking point either.
    if (v == null || v >= 0) continue
    if (best === null || v > series[best].barVelocity!) best = i
  }
  return best
}

// ---------------------------------------------------------------------------
// Storage (11e-4)
// ---------------------------------------------------------------------------
//
// A pose track is roughly sixty times the size of a bar path — 33 landmarks a
// frame against a path's single point — so it does NOT go in video_analyses as
// another JSON TEXT column. The reasoning that put the bar path there (about
// 10 KB, always read whole, rides along in the database backup) stops holding at
// a quarter of a megabyte a row.
//
// Packed as flat Float32Arrays, frame-major. A 300-frame track is ~119 KB per
// set of coordinates against ~500 KB of JSON text, and it parses without
// building thirty thousand objects.

/** x, y, visibility — or x, y, z for the world set. */
export const FLOATS_PER_LANDMARK = 3

export interface PackedPose {
  frameCount: number
  landmarkCount: number
  /** Image space, video pixels: [frame][landmark][x, y, visibility]. */
  keypoints: Float32Array
  /** Metres, hip-centred: [frame][landmark][x, y, z]. Null on a track stored before 11e-0's fix. */
  world: Float32Array | null
  /**
   * mediaTime per frame. Float64, unlike the coordinates.
   *
   * Timestamps are matched against the bar path's, which travels as JSON and is
   * therefore double precision. Rounding one side and not the other would
   * introduce a drift that only shows up as a skeleton a frame out from the dot
   * — and the whole array is a couple of kilobytes, so there is nothing to save.
   */
  times: Float64Array
}

export function packPose(frames: PoseFrame[], landmarkCount = LANDMARK_COUNT): PackedPose {
  const stride = landmarkCount * FLOATS_PER_LANDMARK
  const keypoints = new Float32Array(frames.length * stride)
  const times = new Float64Array(frames.length)
  // Only allocated when every frame has world landmarks. A partial set would be
  // worse than none: the angle code would silently switch basis mid-clip.
  const hasWorld = frames.length > 0 && frames.every((f) => f.world != null)
  const world = hasWorld ? new Float32Array(frames.length * stride) : null

  frames.forEach((frame, f) => {
    times[f] = frame.t
    for (let i = 0; i < landmarkCount; i++) {
      const at = f * stride + i * FLOATS_PER_LANDMARK
      const l = frame.landmarks[i]
      keypoints[at] = l?.x ?? 0
      keypoints[at + 1] = l?.y ?? 0
      keypoints[at + 2] = l?.visibility ?? 0
      if (world) {
        const w = frame.world![i]
        world[at] = w?.x ?? 0
        world[at + 1] = w?.y ?? 0
        world[at + 2] = w?.z ?? 0
      }
    }
  })

  return { frameCount: frames.length, landmarkCount, keypoints, world, times }
}

export function unpackPose(packed: PackedPose): PoseFrame[] {
  const { frameCount, landmarkCount, keypoints, world, times } = packed
  const stride = landmarkCount * FLOATS_PER_LANDMARK
  const frames: PoseFrame[] = []

  for (let f = 0; f < frameCount; f++) {
    const landmarks: Landmark[] = []
    const worldLandmarks: Landmark[] = []
    for (let i = 0; i < landmarkCount; i++) {
      const at = f * stride + i * FLOATS_PER_LANDMARK
      landmarks.push({ x: keypoints[at], y: keypoints[at + 1], visibility: keypoints[at + 2] })
      if (world) {
        // Visibility lives on the image set only — see frameAngles for why the
        // gate stays there. Carried as 1 so a world point is never itself the
        // reason an angle is refused.
        worldLandmarks.push({ x: world[at], y: world[at + 1], z: world[at + 2], visibility: 1 })
      }
    }
    frames.push({ t: times[f], landmarks, ...(world ? { world: worldLandmarks } : {}) })
  }
  return frames
}

/**
 * One landmark the coach has moved by hand.
 *
 * Image space, video pixels, like everything else drawn. Stored against a frame
 * INDEX rather than a timestamp: a correction belongs to the frame the coach was
 * looking at, and float timestamps are a poor primary key.
 */
export interface PoseCorrection {
  frameIndex: number
  landmark: number
  x: number
  y: number
}

/**
 * Layers the coach's fixes over the model's output, without touching it.
 *
 * Corrections are stored separately and applied on READ, never written back.
 * Re-running the model must not destroy what the coach fixed, and "what the
 * model saw" has to stay distinguishable from "what the coach said it was" —
 * the same instinct as PATCH /api/analysis/:id refusing to edit a tracked path
 * because it is a measurement.
 *
 * A corrected landmark becomes fully visible: the coach has just said where it
 * is, which is exactly the certainty `visibility` encodes.
 *
 * It also DROPS that frame's world landmarks. The 3D estimate for a joint the
 * coach has just contradicted is no longer the model's coherent guess, and
 * quietly measuring angles off it would ignore the correction entirely — the
 * coach would drag a knee and watch the number not move. Losing metric depth for
 * those frames is the honest cost, and `FrameAngles.metric` reports it.
 */
export function applyCorrections(
  frames: PoseFrame[],
  corrections: PoseCorrection[],
): PoseFrame[] {
  if (corrections.length === 0) return frames

  const byFrame = new Map<number, PoseCorrection[]>()
  for (const c of corrections) {
    const list = byFrame.get(c.frameIndex)
    if (list) list.push(c)
    else byFrame.set(c.frameIndex, [c])
  }

  return frames.map((frame, i) => {
    const fixes = byFrame.get(i)
    if (!fixes) return frame
    const landmarks = frame.landmarks.slice()
    for (const fix of fixes) {
      if (fix.landmark < 0 || fix.landmark >= landmarks.length) continue
      landmarks[fix.landmark] = { x: fix.x, y: fix.y, visibility: 1 }
    }
    return { t: frame.t, landmarks }
  })
}

/**
 * A correction pinned to a MOMENT rather than to an array position.
 *
 * What the coach corrects before tracking has run is a preview: frames for the
 * parts of the clip they happened to watch, in whatever order they scrubbed
 * through. Running the tracker afterwards rebuilds the track from scratch, and
 * every frame index the preview used stops meaning the same instant.
 *
 * A timestamp survives that. The coach fixed the knee at 2.4 seconds; it is
 * still 2.4 seconds after a re-track, whatever index that frame now sits at.
 */
export interface TimedCorrection {
  t: number
  landmark: number
  x: number
  y: number
}

/**
 * Resolves time-pinned corrections against a particular track.
 *
 * `maxGapS` refuses to move a correction onto a frame that is not really the one
 * the coach was looking at — better to drop a fix than to draw it half a second
 * from where it was made. Two frames at 30 fps by default, matching the join in
 * anglesAgainstBar.
 *
 * Later corrections win on collision: re-dragging the same joint on the same
 * frame replaces it rather than fighting with the earlier position.
 */
export function correctionsAtTimes(
  frames: PoseFrame[],
  timed: TimedCorrection[],
  maxGapS = 0.067,
): PoseCorrection[] {
  if (frames.length === 0) return []
  const byKey = new Map<string, PoseCorrection>()
  for (const c of timed) {
    const frameIndex = frameIndexAt(frames, c.t)
    if (frameIndex < 0) continue
    if (Math.abs(frames[frameIndex].t - c.t) > maxGapS) continue
    byKey.set(`${frameIndex}:${c.landmark}`, { frameIndex, landmark: c.landmark, x: c.x, y: c.y })
  }
  return [...byKey.values()]
}

/**
 * Adds a frame to a track, keeping it in time order.
 *
 * Preview inference produces frames in whatever order the coach scrubs, and
 * every reader here — frameIndexAt's binary search, the angle series, the
 * packing — assumes time order. Sorting the whole array on each arrival would be
 * O(n log n) per frame; this is one splice into an already-sorted list.
 *
 * A frame at essentially the same instant REPLACES the one there rather than
 * accumulating beside it: scrubbing back and forth over one moment should leave
 * one reading of it, not a pile.
 */
export function insertFrame(frames: PoseFrame[], frame: PoseFrame, sameFrameS = 0.001): PoseFrame[] {
  const next = frames.slice()
  let lo = 0
  let hi = next.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (next[mid].t < frame.t) lo = mid + 1
    else hi = mid
  }
  if (lo < next.length && Math.abs(next[lo].t - frame.t) <= sameFrameS) next[lo] = frame
  else if (lo > 0 && Math.abs(next[lo - 1].t - frame.t) <= sameFrameS) next[lo - 1] = frame
  else next.splice(lo, 0, frame)
  return next
}

/**
 * The frame nearest a playhead time.
 *
 * Binary search rather than the linear scan the bar-path overlay uses: that one
 * walks a few hundred points, this one would walk 33 landmarks x N frames on
 * every animation frame. Returns an index so a caller can reuse it against
 * parallel series (angles, corrections) without searching each of them.
 */
export function frameIndexAt(frames: PoseFrame[], t: number): number {
  if (frames.length === 0) return -1
  let lo = 0
  let hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid].t < t) lo = mid + 1
    else hi = mid
  }
  // `lo` is the first frame at or after t; the one before it can be nearer.
  if (lo > 0 && Math.abs(frames[lo - 1].t - t) <= Math.abs(frames[lo].t - t)) return lo - 1
  return lo
}
