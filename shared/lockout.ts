// ---------------------------------------------------------------------------
// Lockout at the top of each rep, judged (BP32, D118, D120). Advice only.
//
// Read from the skeleton as the clip was read and the legs rebuilt
// (poseRefine.ts): the straightest knee and hip in the second after the bar
// stopped going up. Side-on only — from the side the knee and hip angles are
// what the picture shows; from the front nothing has been measured to trust.
//
// The thresholds are deliberately loose (D120): no clip of a soft lockout has
// been measured yet, so only a clearly bent joint is flagged. Measured in the
// packaged app on real side-on clips (Fabian, 70 kg), every rep locked out and
// read knee 167-176, hip 173-180 on the deadlift and 159-164 on the squat — the
// bar on the back tips the torso, so the squat's hip is held to less.
// ---------------------------------------------------------------------------

import { cameraSide, frameAngles, type PoseFrame } from './pose.js'
import { isSideOn } from './poseRefine.js'

const SQUATS = ['back-squat', 'front-squat']
const DEADLIFTS = ['deadlift-conventional', 'deadlift-sumo', 'deadlift-trapbar']

/** Under this the knee is clearly still bent at the top. */
export const KNEE_LOCKED_MIN = 150
/** Under this the hips are clearly not through. */
export const HIP_LOCKED_MIN = { squat: 140, deadlift: 150 } as const

/** How long after the bar stops going up the top is looked for, in seconds. */
const TOP_WINDOW_S = 1

export interface RepLockout {
  /** The straightest the knee got at the top, degrees. Null when it was not seen. */
  knee: number | null
  hip: number | null
  /** Both read and both past their line. */
  locked: boolean
}

/** Whether a lift gets a lockout mark. */
export const hasLockoutCheck = (lift: string | null | undefined): boolean =>
  !!lift && (SQUATS.includes(lift) || DEADLIFTS.includes(lift))

/**
 * Each rep's lockout, keyed by rep index. Null when the lift has no check,
 * there is no skeleton, or the clip was not filmed side-on; a rep whose top
 * the skeleton did not see maps to null.
 */
export function repLockouts(
  frames: PoseFrame[] | null | undefined,
  reps: { index: number; startT: number; endT: number }[],
  lift: string | null | undefined,
): Map<number, RepLockout | null> | null {
  if (!hasLockoutCheck(lift) || !frames || frames.length < 2 || reps.length === 0 || !isSideOn(frames)) return null
  const hipMin = SQUATS.includes(lift!) ? HIP_LOCKED_MIN.squat : HIP_LOCKED_MIN.deadlift
  const angles = frameAngles(frames, cameraSide(frames))
  const sorted = [...reps].sort((a, b) => a.startT - b.startT)
  const out = new Map<number, RepLockout | null>()
  sorted.forEach((r, i) => {
    // From just before the bar stopped to a second after, never into the next rep's bottom.
    const from = r.endT - 0.15
    const to = Math.min(r.endT + TOP_WINDOW_S, sorted[i + 1] ? sorted[i + 1].startT : Infinity)
    let knee: number | null = null
    let hip: number | null = null
    for (const a of angles) {
      if (a.t < from || a.t > to) continue
      if (a.knee != null && (knee == null || a.knee > knee)) knee = a.knee
      if (a.hip != null && (hip == null || a.hip > hip)) hip = a.hip
    }
    out.set(r.index, knee == null || hip == null ? null : { knee, hip, locked: knee >= KNEE_LOCKED_MIN && hip >= hipMin })
  })
  return [...out.values()].every((v) => v == null) ? null : out
}
