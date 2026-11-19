// ---------------------------------------------------------------------------
// The legs, rebuilt from what the whole clip agrees on (BP32, D117).
//
// Filmed from the side, a loaded bar hides the legs: at the bottom of a
// deadlift the plate covers the shins and feet, at lockout it covers the hip
// and knee, and the model then puts the knee on the plate and the ankle at knee
// height (measured on a real side-on deadlift: the knee read 22-39 degrees at
// the start, which no body can do).
//
// Two things hold through a set, whatever the plate covers: the feet stay
// planted, and the bones keep their length. So the clip is analysed as a
// whole first. Where the feet are is where most frames agree they are; the
// shin and thigh are measured on those frames; and on a frame whose leg does
// not fit, the knee is put where it has to be — the thigh's length from the
// hip and the shin's length from the planted ankle, on the side the toes point
// to. On that deadlift the rebuilt leg sits on the real one through the whole
// pull (Fabian's idea, 2026-11-20).
//
// ONLY SIDE-ON. Lengths in pixels are only lengths when the leg moves across
// the picture; filmed from the front the shin foreshortens as the knee comes
// forward, and the same arithmetic would bend a straight leg. A side-on clip
// is told by the shoulders: from the side they overlap (measured 0.03-0.14 of
// the torso's length), from the front they are most of it (0.68-1.07).
//
// The stored track stays the measurement; this, like smooth(), is for what is
// drawn and read.
// ---------------------------------------------------------------------------

import { LM, smooth, type Landmark, type PoseFrame, type Side } from './pose.js'

/**
 * What is drawn and read from a measured track: the legs rebuilt where the
 * clip shows they were wrong, then the median filter. Same frames, same order,
 * so corrections pinned to a frame index still land; they go on after this.
 */
export function displayPose(measured: PoseFrame[]): PoseFrame[] {
  return measured.length < 3 ? measured : smooth(refineLegs(measured).frames)
}

/** Shoulder width over torso length, below which a clip counts as filmed side-on. */
export const SIDE_ON_MAX_SHOULDER_RATIO = 0.35

/** Fewer frames than this and there is nothing to agree on. */
const MIN_FRAMES = 10

/** How near the planted ankle a frame's ankle must be to count as agreeing, as a share of the leg. */
const ANCHOR_RADIUS = 0.1

/**
 * How far a bone may read from its length before the leg is rebuilt, as a
 * share of that length.
 *
 * Deliberately not "is the knee where the bones say": near a straight leg that
 * position swings wildly with the hip. Standing still, the model's hip moves
 * enough that the leg's length reads 787-849 px across frames (±4%), and with
 * the bones fixed, 2% short already puts the knee at 150 degrees — so judging
 * by it rebuilt a straight standing leg into a bent one. A frame the model read
 * sensibly is kept; an odd one out among good neighbours is smooth()'s job.
 */
const BONE_TOLERANCE = 0.2

/** What a rebuilt joint is marked as: seen, though not by the model on this frame. */
const REBUILT_VISIBILITY = 0.9

const LEG = {
  left: { hip: LM.LEFT_HIP, knee: LM.LEFT_KNEE, ankle: LM.LEFT_ANKLE, heel: LM.LEFT_HEEL, toe: LM.LEFT_FOOT_INDEX },
  right: { hip: LM.RIGHT_HIP, knee: LM.RIGHT_KNEE, ankle: LM.RIGHT_ANKLE, heel: LM.RIGHT_HEEL, toe: LM.RIGHT_FOOT_INDEX },
} as const

type Point = { x: number; y: number }
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const medianPoint = (points: Point[]): Point => ({ x: median(points.map((p) => p.x)), y: median(points.map((p) => p.y)) })

/** Whether the clip was filmed side-on, from how wide the shoulders read against the torso. */
export function isSideOn(frames: PoseFrame[]): boolean {
  const ratios: number[] = []
  for (const f of frames) {
    const ls = f.landmarks[LM.LEFT_SHOULDER], rs = f.landmarks[LM.RIGHT_SHOULDER]
    const lh = f.landmarks[LM.LEFT_HIP], rh = f.landmarks[LM.RIGHT_HIP]
    if (!ls || !rs || !lh || !rh) continue
    const torso = dist({ x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }, { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 })
    if (torso > 0) ratios.push(Math.abs(ls.x - rs.x) / torso)
  }
  return ratios.length >= MIN_FRAMES && median(ratios) < SIDE_ON_MAX_SHOULDER_RATIO
}

export interface LegRefinement {
  frames: PoseFrame[]
  /** Whether the clip was judged side-on; nothing is rebuilt otherwise. */
  sideOn: boolean
  /** The leg whose planted foot the most frames agree on — the one the camera sees. Null when nothing was learned. */
  side: Side | null
  /** How many frames had their leg rebuilt. */
  rebuilt: number
}

/**
 * Rebuilds the near leg on the frames where it does not fit the rest of the
 * clip. Hands the input back untouched when the clip is not side-on or too
 * short to learn from, and leaves every frame whose leg already fits as it was.
 */
export function refineLegs(frames: PoseFrame[]): LegRefinement {
  const unchanged = (sideOn: boolean): LegRefinement => ({ frames, sideOn, side: null, rebuilt: 0 })
  if (frames.length < MIN_FRAMES) return unchanged(false)
  if (!isSideOn(frames)) return unchanged(false)

  // The scale everything is judged against: a leg, hip to ankle along the bones.
  const legLength = median(frames.flatMap((f) => (['left', 'right'] as const).map((s) => {
    const j = LEG[s], l = f.landmarks
    return dist(l[j.hip], l[j.knee]) + dist(l[j.knee], l[j.ankle])
  })))
  if (!(legLength > 0)) return unchanged(true)
  const radius = ANCHOR_RADIUS * legLength

  // The planted foot, per side: the ankle position the most frames agree on.
  const learn = (side: Side) => {
    const j = LEG[side]
    const ankles = frames.map((f) => f.landmarks[j.ankle])
    let best: Landmark = ankles[0]
    let bestCount = 0
    for (const a of ankles) {
      let n = 0
      for (const b of ankles) if (dist(a, b) < radius) n++
      if (n > bestCount) { bestCount = n; best = a }
    }
    const agreeing = frames.filter((f) => dist(f.landmarks[j.ankle], best) < radius)
    return { side, agreeing }
  }
  const [left, right] = [learn('left'), learn('right')]
  const near = right.agreeing.length > left.agreeing.length ? right : left
  if (near.agreeing.length < Math.max(5, frames.length * 0.15)) return unchanged(true)

  const j = LEG[near.side]
  const far = LEG[near.side === 'left' ? 'right' : 'left']
  const at = (f: PoseFrame, i: number) => f.landmarks[i]
  const ankle = medianPoint(near.agreeing.map((f) => at(f, j.ankle)))
  const heel = medianPoint(near.agreeing.map((f) => at(f, j.heel)))
  const toe = medianPoint(near.agreeing.map((f) => at(f, j.toe)))
  const shin = median(near.agreeing.map((f) => dist(at(f, j.knee), at(f, j.ankle))))
  const thigh = median(near.agreeing.map((f) => dist(at(f, j.hip), at(f, j.knee))))
  // Knees bend the way the toes point.
  const forward = Math.sign(toe.x - ankle.x) || 1

  /** Where the knee has to be: the thigh's length from the hip, the shin's from the ankle, toward the toes. */
  const kneeFor = (hip: Point): Point => {
    const d = dist(hip, ankle)
    if (d === 0) return { x: ankle.x, y: ankle.y - shin }
    // Farther apart than the leg is long: the leg is straight, on the line between them.
    if (d >= thigh + shin) return { x: ankle.x + ((hip.x - ankle.x) * shin) / d, y: ankle.y + ((hip.y - ankle.y) * shin) / d }
    // The two circles meet `a` along the ankle-hip line and `h` either side of it.
    const a = (shin * shin - thigh * thigh + d * d) / (2 * d)
    const h = Math.sqrt(Math.max(0, shin * shin - a * a))
    const mx = ankle.x + ((hip.x - ankle.x) * a) / d
    const my = ankle.y + ((hip.y - ankle.y) * a) / d
    const px = -(hip.y - ankle.y) / d
    const py = (hip.x - ankle.x) / d
    const k1 = { x: mx + h * px, y: my + h * py }
    const k2 = { x: mx - h * px, y: my - h * py }
    return (k1.x - mx) * forward > 0 ? k1 : k2
  }

  let rebuilt = 0
  const out = frames.map((f) => {
    const hip = at(f, j.hip), knee = at(f, j.knee), ank = at(f, j.ankle)
    const fits =
      dist(ank, ankle) < radius &&
      Math.abs(dist(hip, knee) - thigh) <= thigh * BONE_TOLERANCE &&
      Math.abs(dist(knee, ank) - shin) <= shin * BONE_TOLERANCE
    if (fits) return f
    rebuilt++
    const k = kneeFor(hip)
    const landmarks = f.landmarks.slice()
    const put = (i: number, p: Point) => { landmarks[i] = { x: p.x, y: p.y, visibility: Math.max(REBUILT_VISIBILITY, f.landmarks[i]?.visibility ?? 0) } }
    put(j.knee, k)
    put(j.ankle, ankle)
    put(j.heel, heel)
    put(j.toe, toe)
    // The far leg is behind the near one from the side; on these frames the
    // model was guessing at it too. Laid under the near leg and marked unseen.
    for (const key of ['knee', 'ankle', 'heel', 'toe'] as const) {
      const src = landmarks[j[key]]
      landmarks[far[key]] = { x: src.x, y: src.y, visibility: 0 }
    }
    // The 3D estimate of this frame put the knee where the picture does not,
    // so it is dropped: side-on, the angles read true off the picture.
    return { t: f.t, landmarks }
  })
  return { frames: out, sideOn: true, side: near.side, rebuilt }
}
