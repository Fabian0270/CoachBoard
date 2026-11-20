import { describe, it, expect } from 'vitest'
import { LM, LANDMARK_COUNT, POSE_BONES, frameAngles, type Landmark, type PoseFrame } from 'coachboard-shared/pose'
import { isSideOn, refineLegs, visibleBones } from 'coachboard-shared/poseRefine'

// BP32, D117: the legs rebuilt from what the whole clip agrees on. Every pose
// here is built from known joint angles, so where the knee truly is, is known.

const at = (x: number, y: number, visibility = 1): Landmark => ({ x, y, visibility })
const ANKLE = { x: 500, y: 900 }
const SHIN = 200
const THIGH = 210
const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * A lifter side-on, facing right (toes at +x), left leg nearest. `shinLean` is
 * how far the shin tips forward from vertical, `kneeBend` how far the thigh
 * folds back from the shin's line (0 = straight leg).
 */
function lifter(t: number, shinLean: number, kneeBend: number, opts: { shoulderWidth?: number } = {}) {
  const knee = { x: ANKLE.x + SHIN * Math.sin(rad(shinLean)), y: ANKLE.y - SHIN * Math.cos(rad(shinLean)) }
  const thighDir = rad(shinLean - kneeBend) // from vertical, + leans forward
  const hip = { x: knee.x + THIGH * Math.sin(thighDir), y: knee.y - THIGH * Math.cos(thighDir) }
  const shoulder = { x: hip.x + 40, y: hip.y - 320 }
  const w = opts.shoulderWidth ?? 10
  const landmarks = Array.from({ length: LANDMARK_COUNT }, () => at(0, 0, 0))
  const set = (i: number, p: { x: number; y: number }, v = 1) => { landmarks[i] = at(p.x, p.y, v) }
  set(LM.LEFT_SHOULDER, shoulder); set(LM.RIGHT_SHOULDER, { x: shoulder.x + w, y: shoulder.y })
  set(LM.LEFT_HIP, hip); set(LM.RIGHT_HIP, { x: hip.x + w / 3, y: hip.y })
  for (const [k, a, h, f] of [[LM.LEFT_KNEE, LM.LEFT_ANKLE, LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE, LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX]]) {
    set(k, knee); set(a, ANKLE); set(h, { x: ANKLE.x - 30, y: ANKLE.y + 20 }); set(f, { x: ANKLE.x + 120, y: ANKLE.y + 25 })
  }
  const frame: PoseFrame = { t, landmarks }
  return { frame, knee, hip }
}

/** What the plate does to the model: the knee and ankle land somewhere else entirely. */
function hidden(f: PoseFrame): PoseFrame {
  const landmarks = f.landmarks.slice()
  for (const [k, a] of [[LM.LEFT_KNEE, LM.LEFT_ANKLE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE]]) {
    landmarks[k] = at(f.landmarks[LM.LEFT_HIP].x - 120, f.landmarks[LM.LEFT_HIP].y + 40, 0.8)
    landmarks[a] = at(f.landmarks[LM.LEFT_HIP].x - 140, f.landmarks[LM.LEFT_HIP].y + 160, 0.8)
  }
  return { ...f, landmarks, world: f.landmarks }
}

/** A pull: knee bend from 70 down to 0 and back, 40 frames, legs hidden on every other one. */
function pull(opts: { shoulderWidth?: number } = {}) {
  const truth = Array.from({ length: 40 }, (_, i) => {
    const bend = 70 * Math.abs(Math.cos((i / 39) * Math.PI))
    return lifter(i / 10, bend * 0.4, bend, opts)
  })
  const frames = truth.map((p, i) => (i % 2 === 1 ? hidden(p.frame) : p.frame))
  return { truth, frames }
}

describe('visibleBones', () => {
  const joints = (bones: readonly (readonly [number, number])[]) => new Set(bones.flat())
  it('side-on: only the side facing the camera — on a squat without the arm', () => {
    const { frames } = pull()
    const squat = joints(visibleBones(frames, 'back-squat'))
    expect([...squat].sort((a, b) => a - b)).toEqual([LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE, LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX].sort((a, b) => a - b))
    expect(joints(visibleBones(frames, 'front-squat')).has(LM.LEFT_ELBOW)).toBe(false)
  })

  it('bench: only the arms and shoulders, from any side', () => {
    const front = joints(visibleBones(pull({ shoulderWidth: 260 }).frames, 'bench-press'))
    expect([...front].sort((a, b) => a - b)).toEqual([LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST].sort((a, b) => a - b))
    const side = joints(visibleBones(pull().frames, 'bench-press'))
    expect([...side].sort((a, b) => a - b)).toEqual([LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST].sort((a, b) => a - b))
  })

  it('side-on deadlift keeps the near arm: lockout is judged on it', () => {
    const { frames } = pull()
    for (const lift of ['deadlift-conventional', null]) {
      const j = joints(visibleBones(frames, lift))
      expect(j.has(LM.LEFT_ELBOW) && j.has(LM.LEFT_WRIST), String(lift)).toBe(true)
      expect(j.has(LM.RIGHT_KNEE) || j.has(LM.RIGHT_SHOULDER), String(lift)).toBe(false)
    }
  })

  it('from the front, the whole skeleton', () => {
    expect(visibleBones(pull({ shoulderWidth: 260 }).frames, 'back-squat')).toBe(POSE_BONES)
  })
})

describe('refineLegs', () => {
  it('rebuilds a hidden knee where the bones say it is, on the planted foot', () => {
    const { truth, frames } = pull()
    const r = refineLegs(frames)
    expect(r.sideOn).toBe(true)
    expect(r.rebuilt).toBe(20)
    const angles = frameAngles(r.frames, 'left')
    const trueAngles = frameAngles(truth.map((p) => p.frame), 'left')
    r.frames.forEach((f, i) => {
      const k = f.landmarks[LM.LEFT_KNEE]
      expect(Math.hypot(k.x - truth[i].knee.x, k.y - truth[i].knee.y), `frame ${i}`).toBeLessThan(1)
      expect(Math.abs(angles[i].knee! - trueAngles[i].knee!), `frame ${i}`).toBeLessThan(1)
      expect(f.landmarks[LM.LEFT_ANKLE]).toMatchObject({ x: ANKLE.x, y: ANKLE.y })
    })
  })

  it('a straight standing leg the model read sensibly stays straight, even when the hip reads a little low', () => {
    const { frames } = pull()
    // Standing, the hip read 3% nearer the ankle than the leg is long.
    const standing = lifter(9, 0, 0).frame
    const low = { ...standing, landmarks: standing.landmarks.slice() }
    low.landmarks[LM.LEFT_HIP] = at(ANKLE.x, ANKLE.y - (SHIN + THIGH) * 0.97)
    low.landmarks[LM.LEFT_KNEE] = at(ANKLE.x, ANKLE.y - SHIN * 0.97)
    const r = refineLegs([...frames, low])
    expect(r.frames.at(-1)).toBe(low)
    expect(frameAngles([r.frames.at(-1)!], 'left')[0].knee).toBeCloseTo(180, 0)
  })

  it('leaves every frame that already fits exactly as measured', () => {
    const { frames } = pull()
    const r = refineLegs(frames)
    frames.forEach((f, i) => { if (i % 2 === 0) expect(r.frames[i]).toBe(f) })
  })

  it('a rebuilt frame reads its angles off the picture, which is true side-on', () => {
    const { truth, frames } = pull()
    const r = refineLegs(frames)
    expect(r.frames[1].world).toBeUndefined()
    const knee = frameAngles([r.frames[1]], 'left')[0].knee!
    const trueKnee = frameAngles([truth[1].frame], 'left')[0].knee!
    expect(knee).toBeCloseTo(trueKnee, 0)
  })

  it('the far leg on a rebuilt frame lies under the near one, marked unseen', () => {
    const r = refineLegs(pull().frames)
    const f = r.frames[1]
    expect(f.landmarks[LM.RIGHT_KNEE]).toMatchObject({ x: f.landmarks[LM.LEFT_KNEE].x, visibility: 0 })
  })

  it('a far leg read onto the plate is laid under the near one, even when the near leg was read right', () => {
    const { frames } = pull()
    const f = { ...frames[0], landmarks: frames[0].landmarks.slice() }
    f.landmarks[LM.RIGHT_KNEE] = at(f.landmarks[LM.LEFT_HIP].x - 120, f.landmarks[LM.LEFT_HIP].y + 40, 0.8)
    f.landmarks[LM.RIGHT_ANKLE] = at(f.landmarks[LM.LEFT_HIP].x - 140, f.landmarks[LM.LEFT_HIP].y + 160, 0.8)
    const r = refineLegs([f, ...frames.slice(1)])
    expect(r.rebuilt).toBe(20) // the near leg on this frame is as measured
    expect(r.frames[0].landmarks[LM.LEFT_KNEE]).toBe(f.landmarks[LM.LEFT_KNEE])
    expect(r.frames[0].landmarks[LM.RIGHT_KNEE]).toMatchObject({ x: f.landmarks[LM.LEFT_KNEE].x, y: f.landmarks[LM.LEFT_KNEE].y, visibility: 0 })
  })

  it('a hip farther away than the leg is long means a straight leg, not a guess', () => {
    const { frames } = pull()
    const stretched = hidden(lifter(9, 0, 0).frame)
    stretched.landmarks[LM.LEFT_HIP] = at(ANKLE.x, ANKLE.y - SHIN - THIGH - 30)
    const r = refineLegs([...frames, stretched])
    const f = r.frames.at(-1)!
    expect(f.landmarks[LM.LEFT_KNEE].x).toBeCloseTo(ANKLE.x, 5)
    expect(frameAngles([f], 'left')[0].knee).toBeCloseTo(180, 0)
  })

  it('filmed from the front, nothing is rebuilt', () => {
    const { frames } = pull({ shoulderWidth: 260 })
    expect(isSideOn(frames)).toBe(false)
    const r = refineLegs(frames)
    expect(r).toMatchObject({ sideOn: false, rebuilt: 0 })
    expect(r.frames).toBe(frames)
  })

  it('too short to learn from, or no foot most frames agree on: unchanged', () => {
    expect(refineLegs(pull().frames.slice(0, 5)).frames).toHaveLength(5)
    expect(refineLegs(pull().frames.slice(0, 5)).rebuilt).toBe(0)
    const allHidden = pull().truth.map((p, i) => {
      const f = hidden(p.frame)
      // Hidden somewhere different each time: no planted foot to find.
      f.landmarks[LM.LEFT_ANKLE] = at(100 + i * 50, 100 + i * 40); f.landmarks[LM.RIGHT_ANKLE] = at(900 - i * 50, 100 + i * 40)
      return f
    })
    expect(refineLegs(allHidden).rebuilt).toBe(0)
  })
})
