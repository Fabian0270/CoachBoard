import { describe, it, expect } from 'vitest'
import { LM, LANDMARK_COUNT, type Landmark, type PoseFrame } from 'coachboard-shared/pose'
import { repLockouts, hasLockoutCheck, KNEE_LOCKED_MIN } from 'coachboard-shared/lockout'

// BP32, D118, D120: lockout at the top of each rep, advice only.

const at = (x: number, y: number, visibility = 1): Landmark => ({ x, y, visibility })
const rad = (d: number) => (d * Math.PI) / 180

/**
 * A side-on lifter (left side near) whose knee reads `knee` degrees and hip
 * `hip` degrees: shin vertical, thigh folded back from it, torso folded
 * forward from the thigh. `shoulderWidth` wide shoulders read as a front view.
 */
function pose(t: number, knee: number, hip: number, shoulderWidth = 8): PoseFrame {
  const ankle = { x: 500, y: 900 }
  const kneeP = { x: 500, y: 700 }
  const thighDir = rad(180 - knee) // from vertical, leaning back-up from the knee
  const hipP = { x: kneeP.x - 200 * Math.sin(thighDir), y: kneeP.y - 200 * Math.cos(thighDir) }
  const torsoDir = thighDir - rad(180 - hip)
  const shoulder = { x: hipP.x - 300 * Math.sin(torsoDir), y: hipP.y - 300 * Math.cos(torsoDir) }
  const lm = Array.from({ length: LANDMARK_COUNT }, () => at(0, 0, 0))
  const both = (l: number, r: number, p: { x: number; y: number }, dx = 2) => { lm[l] = at(p.x, p.y); lm[r] = at(p.x + dx, p.y) }
  both(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, shoulder, shoulderWidth)
  both(LM.LEFT_HIP, LM.RIGHT_HIP, hipP)
  both(LM.LEFT_KNEE, LM.RIGHT_KNEE, kneeP)
  both(LM.LEFT_ANKLE, LM.RIGHT_ANKLE, ankle)
  both(LM.LEFT_FOOT_INDEX, LM.RIGHT_FOOT_INDEX, { x: 620, y: 920 })
  both(LM.LEFT_HEEL, LM.RIGHT_HEEL, { x: 470, y: 920 })
  return { t, landmarks: lm }
}

/** A set: down to the bottom, up, and the top held — `topKnee`/`topHip` at each rep's top. */
function set(tops: { knee: number; hip: number }[], shoulderWidth?: number) {
  const frames: PoseFrame[] = []
  const reps = tops.map((top, i) => {
    const start = i * 4
    for (let k = 0; k <= 20; k++) frames.push(pose(start + k * 0.1, 70, 60, shoulderWidth)) // the bottom
    for (let k = 21; k <= 40; k++) frames.push(pose(start + k * 0.1, top.knee, top.hip, shoulderWidth)) // the top
    return { index: i, startT: start + 1.5, endT: start + 2.1 }
  })
  return { frames, reps }
}

describe('repLockouts', () => {
  it('a straight knee and hips through: locked out', () => {
    const { frames, reps } = set([{ knee: 178, hip: 175 }])
    const r = repLockouts(frames, reps, 'deadlift-conventional')!.get(0)!
    expect(r.locked).toBe(true)
    expect(r.knee!).toBeCloseTo(178, 0)
    expect(r.hip!).toBeCloseTo(175, 0)
  })

  it('a clearly bent knee at the top is flagged, rep by rep', () => {
    const { frames, reps } = set([{ knee: 178, hip: 175 }, { knee: KNEE_LOCKED_MIN - 15, hip: 175 }])
    const m = repLockouts(frames, reps, 'back-squat')!
    expect(m.get(0)!.locked).toBe(true)
    expect(m.get(1)!.locked).toBe(false)
  })

  it('hips: a deadlift is held to more than a squat, where the bar on the back tips the torso', () => {
    const { frames, reps } = set([{ knee: 178, hip: 145 }])
    expect(repLockouts(frames, reps, 'deadlift-conventional')!.get(0)!.locked).toBe(false)
    expect(repLockouts(frames, reps, 'back-squat')!.get(0)!.locked).toBe(true)
  })

  it('reads the straightest moment: one frame bent in a held top does not flag it', () => {
    const { frames, reps } = set([{ knee: 178, hip: 175 }])
    frames[25] = pose(frames[25].t, 120, 120)
    expect(repLockouts(frames, reps, 'deadlift-conventional')!.get(0)!.locked).toBe(true)
  })

  it('only squats and deadlifts, and only filmed side-on', () => {
    const { frames, reps } = set([{ knee: 178, hip: 175 }])
    expect(hasLockoutCheck('bench-press')).toBe(false)
    expect(repLockouts(frames, reps, 'bench-press')).toBeNull()
    expect(repLockouts(frames, reps, null)).toBeNull()
    const front = set([{ knee: 178, hip: 175 }], 260)
    expect(repLockouts(front.frames, front.reps, 'back-squat')).toBeNull()
  })

  it('a top the skeleton did not see is no reading, not a verdict', () => {
    const { frames, reps } = set([{ knee: 178, hip: 175 }, { knee: 178, hip: 175 }])
    for (const f of frames) if (f.t > 4) for (const i of [LM.LEFT_KNEE, LM.RIGHT_KNEE]) f.landmarks[i] = at(f.landmarks[i].x, f.landmarks[i].y, 0.1)
    const m = repLockouts(frames, reps, 'back-squat')!
    expect(m.get(0)!.locked).toBe(true)
    expect(m.get(1)).toBeNull()
  })
})
