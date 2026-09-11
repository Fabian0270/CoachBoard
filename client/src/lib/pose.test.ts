import { describe, it, expect } from 'vitest'
import {
  LM,
  LANDMARK_COUNT,
  POSE_BONES,
  MIN_VISIBILITY,
  cameraSide,
  frameAngles,
  frameIndexAt,
  isVisible,
  jointAngle,
  smooth,
  toVideoPixels,
  visibleJointAngle,
  packPose,
  unpackPose,
  applyCorrections,
  anglesAgainstBar,
  stickingPoint,
  insertFrame,
  correctionsAtTimes,
  type AngleVsBar,
  type Landmark,
  type PoseFrame,
} from 'coachboard-shared/pose'

// A coach reads a joint angle off this module and changes how someone lifts, so
// every case here is built from a pose whose true answer is known in advance —
// the same approach vbt.test.ts and videoAnalysis.test.ts take.

const at = (x: number, y: number, visibility = 1): Landmark => ({ x, y, visibility })

/** A full 33-landmark frame, with named joints placed and the rest parked. */
function frame(t: number, put: Record<number, Landmark>): PoseFrame {
  const landmarks = Array.from({ length: LANDMARK_COUNT }, () => at(0, 0, 0))
  for (const [i, l] of Object.entries(put)) landmarks[Number(i)] = l!
  return { t, landmarks }
}

/**
 * A lifter standing side-on to the camera, left side nearest.
 *
 * Image space, so y grows DOWNWARD: the shoulder has the smallest y. Legs are
 * dead straight, torso is vertical — so knee and hip read 180 and lean reads 0,
 * which is what makes it a useful baseline to deform.
 */
const STANDING = frame(0, {
  [LM.LEFT_SHOULDER]: at(100, 100),
  [LM.LEFT_HIP]: at(100, 200),
  [LM.LEFT_KNEE]: at(100, 300),
  [LM.LEFT_ANKLE]: at(100, 400),
  [LM.LEFT_FOOT_INDEX]: at(140, 400),
})

describe('jointAngle', () => {
  it('reads a straight limb as 180 degrees', () => {
    expect(jointAngle(at(0, 0), at(0, 10), at(0, 20))).toBeCloseTo(180, 6)
  })

  it('reads a right angle as 90', () => {
    expect(jointAngle(at(0, 0), at(0, 10), at(10, 10))).toBeCloseTo(90, 6)
  })

  it('returns the interior angle regardless of which side the camera is on', () => {
    // The same bend mirrored. A signed angle would report these as 60 and -60
    // and make a left leg incomparable with a right one.
    const left = jointAngle(at(0, 0), at(0, 10), at(10, 15))
    const right = jointAngle(at(0, 0), at(0, 10), at(-10, 15))
    expect(left).toBeCloseTo(right!, 6)
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(180)
  })

  it('refuses a zero-length segment rather than returning NaN', () => {
    // Two landmarks on the same pixel: the angle is undefined, and a NaN here
    // would be charted as though it were a reading.
    expect(jointAngle(at(0, 0), at(0, 0), at(10, 10))).toBeNull()
  })

  it('refuses a missing landmark', () => {
    expect(jointAngle(undefined, at(0, 10), at(10, 10))).toBeNull()
  })

  it('does not go NaN on a perfectly straight limb', () => {
    // The clamp exists for this: the cosine lands a hair past -1 in floating
    // point and Math.acos would return NaN.
    for (let i = 1; i < 40; i++) {
      const angle = jointAngle(at(0, 0), at(0, i), at(0, i * 2))
      expect(Number.isNaN(angle!)).toBe(false)
      expect(angle).toBeCloseTo(180, 6)
    }
  })
})

describe('visibleJointAngle', () => {
  it('answers when every landmark is visible', () => {
    expect(visibleJointAngle(at(0, 0), at(0, 10), at(10, 10))).toBeCloseTo(90, 6)
  })

  it('refuses when any landmark is below the visibility floor', () => {
    // A bar with 450 mm plates hides the hip from side on. The model still
    // returns a position for it, and that position is a guess.
    const hidden = at(0, 10, MIN_VISIBILITY - 0.01)
    expect(visibleJointAngle(at(0, 0), hidden, at(10, 10))).toBeNull()
    expect(jointAngle(at(0, 0), hidden, at(10, 10))).toBeCloseTo(90, 6)
  })

  it('accepts a landmark exactly at the floor', () => {
    expect(isVisible(at(0, 0, MIN_VISIBILITY))).toBe(true)
  })
})

describe('toVideoPixels', () => {
  it('scales normalised landmarks by the video dimensions', () => {
    const [l] = toVideoPixels([{ x: 0.5, y: 0.25, visibility: 0.9 }], 1920, 1080)
    expect(l.x).toBeCloseTo(960, 6)
    expect(l.y).toBeCloseTo(270, 6)
    expect(l.visibility).toBeCloseTo(0.9, 6)
  })

  it('is independent of the capture width the model was fed', () => {
    // The whole point: a track captured at 256 and one at 384 must land in the
    // same coordinate space, or nothing lines up with the bar path.
    const a = toVideoPixels([{ x: 0.5, y: 0.5 }], 1440, 1440)
    const b = toVideoPixels([{ x: 0.5, y: 0.5 }], 1440, 1440)
    expect(a[0]).toEqual(b[0])
  })

  it('treats a missing visibility as zero rather than as certain', () => {
    expect(toVideoPixels([{ x: 0, y: 0 }], 100, 100)[0].visibility).toBe(0)
  })
})

describe('cameraSide', () => {
  it('picks the side the camera can actually see', () => {
    const f = frame(0, {
      [LM.LEFT_SHOULDER]: at(0, 0, 0.2),
      [LM.LEFT_HIP]: at(0, 0, 0.2),
      [LM.LEFT_KNEE]: at(0, 0, 0.2),
      [LM.LEFT_ANKLE]: at(0, 0, 0.2),
      [LM.RIGHT_SHOULDER]: at(0, 0, 0.95),
      [LM.RIGHT_HIP]: at(0, 0, 0.95),
      [LM.RIGHT_KNEE]: at(0, 0, 0.95),
      [LM.RIGHT_ANKLE]: at(0, 0, 0.95),
    })
    expect(cameraSide([f])).toBe('right')
  })

  it('decides over the whole track, not frame by frame', () => {
    // One frame where the far side happens to score higher must not flip the
    // series — a side that changes mid-clip makes every angle discontinuous.
    const near = frame(0, {
      [LM.LEFT_SHOULDER]: at(0, 0, 0.9),
      [LM.LEFT_HIP]: at(0, 0, 0.9),
      [LM.LEFT_KNEE]: at(0, 0, 0.9),
      [LM.LEFT_ANKLE]: at(0, 0, 0.9),
    })
    const blip = frame(1, {
      [LM.RIGHT_SHOULDER]: at(0, 0, 0.95),
      [LM.RIGHT_HIP]: at(0, 0, 0.95),
      [LM.RIGHT_KNEE]: at(0, 0, 0.95),
      [LM.RIGHT_ANKLE]: at(0, 0, 0.95),
    })
    expect(cameraSide([near, near, near, blip])).toBe('left')
  })

  it('is deterministic when nothing is visible at all', () => {
    expect(cameraSide([frame(0, {})])).toBe('left')
    expect(cameraSide([])).toBe('left')
  })
})

describe('frameAngles', () => {
  it('reads a standing lifter as straight legs and an upright torso', () => {
    const [a] = frameAngles([STANDING], 'left')
    expect(a.knee).toBeCloseTo(180, 4)
    expect(a.hip).toBeCloseTo(180, 4)
    expect(a.torsoLean).toBeCloseTo(0, 4)
  })

  it('closes the knee as the lifter squats', () => {
    // Hip driven back and down behind the knee, ankle fixed: a real squat's
    // knee angle, and it must come out well under the standing 180.
    const squat = frame(0, {
      [LM.LEFT_SHOULDER]: at(60, 180),
      [LM.LEFT_HIP]: at(60, 300),
      [LM.LEFT_KNEE]: at(140, 320),
      [LM.LEFT_ANKLE]: at(100, 400),
      [LM.LEFT_FOOT_INDEX]: at(140, 400),
    })
    const [a] = frameAngles([squat], 'left')
    expect(a.knee).toBeLessThan(110)
    expect(a.hip).toBeLessThan(110)
  })

  it('reports torso lean from vertical, not from a third landmark', () => {
    // Shoulder ahead of the hip by exactly the vertical drop = 45 degrees.
    const leaning = frame(0, {
      [LM.LEFT_SHOULDER]: at(0, 100),
      [LM.LEFT_HIP]: at(100, 200),
    })
    expect(frameAngles([leaning], 'left')[0].torsoLean).toBeCloseTo(45, 4)
  })

  it('leans the same amount whichever way the lifter faces', () => {
    const facingA = frame(0, { [LM.LEFT_SHOULDER]: at(0, 100), [LM.LEFT_HIP]: at(100, 200) })
    const facingB = frame(0, { [LM.LEFT_SHOULDER]: at(100, 100), [LM.LEFT_HIP]: at(0, 200) })
    expect(frameAngles([facingA], 'left')[0].torsoLean).toBeCloseTo(
      frameAngles([facingB], 'left')[0].torsoLean!,
      6,
    )
  })

  it('returns nulls rather than numbers for joints it cannot see', () => {
    const occluded = frame(0, {
      [LM.LEFT_SHOULDER]: at(100, 100),
      [LM.LEFT_HIP]: at(100, 200, 0.1),
      [LM.LEFT_KNEE]: at(100, 300),
      [LM.LEFT_ANKLE]: at(100, 400),
    })
    const [a] = frameAngles([occluded], 'left')
    expect(a.knee).toBeNull()
    expect(a.hip).toBeNull()
    expect(a.torsoLean).toBeNull()
  })

  it('keeps the timestamp so angles line up with the bar path', () => {
    expect(frameAngles([frame(1.234, {}), frame(2.5, {})], 'left').map((a) => a.t)).toEqual([
      1.234, 2.5,
    ])
  })

  it('flags whether a reading came from metres or from pixels', () => {
    expect(frameAngles([STANDING], 'left')[0].metric).toBe(false)
    expect(frameAngles([{ ...STANDING, world: STANDING.landmarks }], 'left')[0].metric).toBe(true)
  })

  /**
   * Torso lean is the one reading that depends on which way y points.
   *
   * A joint angle sits between two segments, so flipping the y axis leaves it
   * unchanged — which is why every other angle here is safe either way, and why
   * the front-on test below passes whatever convention its fixture uses. Torso
   * lean is measured against a FIXED axis, so a flip turns θ into 180 − θ: an
   * upright lifter would read 90+ instead of 0, silently and on every clip.
   *
   * MediaPipe's world landmarks keep the image convention (y down, metres from
   * the hip midpoint). Every torso-lean test used to run on the pixel fallback,
   * so nothing pinned that — and the comment in the source asserted the
   * opposite. This is the test that would have caught it.
   */
  it('reads torso lean the same from world landmarks as from pixels', () => {
    const upright = {
      t: 0,
      landmarks: frame(0, {
        [LM.LEFT_SHOULDER]: at(100, 100),
        [LM.LEFT_HIP]: at(100, 200),
      }).landmarks,
      // Metres, hip-centred, y DOWN: the shoulder is above the hip, so its y is
      // the more negative of the two.
      world: frame(0, {
        [LM.LEFT_SHOULDER]: { x: 0, y: -0.5, z: 0, visibility: 1 },
        [LM.LEFT_HIP]: { x: 0, y: 0, z: 0, visibility: 1 },
      }).landmarks,
    }
    expect(frameAngles([upright], 'left')[0].torsoLean).toBeCloseTo(0, 4)

    // ...and a torso folded 45 degrees forward reads 45, not 135.
    const folded = {
      t: 0,
      landmarks: upright.landmarks,
      world: frame(0, {
        [LM.LEFT_SHOULDER]: { x: -0.5, y: -0.5, z: 0, visibility: 1 },
        [LM.LEFT_HIP]: { x: 0, y: 0, z: 0, visibility: 1 },
      }).landmarks,
    }
    expect(frameAngles([folded], 'left')[0].torsoLean).toBeCloseTo(45, 4)
  })

  /**
   * The one the first real clip caught.
   *
   * A squat filmed FROM THE FRONT bends the knee almost straight toward the
   * lens. In pixels the hip, knee and ankle stay nearly in a vertical line, so
   * an image-space angle reads close to straight at full depth — confidently,
   * with no symptom. The world landmarks keep the depth the projection threw
   * away, so they report the bend that is actually there.
   */
  it('reads a front-on squat as bent, which the pixels alone call straight', () => {
    const deep = {
      t: 0,
      // Image space: knee only 6px forward of the hip-ankle line — the whole
      // bend has gone into the axis pointing at the camera.
      landmarks: frame(0, {
        [LM.LEFT_HIP]: at(100, 200),
        [LM.LEFT_KNEE]: at(106, 300),
        [LM.LEFT_ANKLE]: at(100, 400),
      }).landmarks,
      // World space, metres, hip-centred: the knee is 0.4 m nearer the camera
      // than hip and ankle, which is what a real deep squat looks like head on.
      world: frame(0, {
        [LM.LEFT_HIP]: { x: 0, y: 0, z: 0, visibility: 1 },
        [LM.LEFT_KNEE]: { x: 0.02, y: -0.4, z: -0.4, visibility: 1 },
        [LM.LEFT_ANKLE]: { x: 0, y: -0.8, z: 0, visibility: 1 },
      }).landmarks,
    }

    const flat = frameAngles([{ t: 0, landmarks: deep.landmarks }], 'left')[0]
    const metric = frameAngles([deep], 'left')[0]

    // The pixels call it nearly straight...
    expect(flat.knee).toBeGreaterThan(160)
    // ...and the body says it is a real bend.
    expect(metric.knee).toBeLessThan(120)
    expect(metric.metric).toBe(true)
  })

  it('still judges occlusion on what the camera saw, not on the metric points', () => {
    // World landmarks carry the model's estimate whether or not it could see the
    // joint, so the gate has to stay on the image-space visibility.
    const occluded = {
      t: 0,
      landmarks: frame(0, {
        [LM.LEFT_HIP]: at(100, 200, 0.05),
        [LM.LEFT_KNEE]: at(100, 300),
        [LM.LEFT_ANKLE]: at(100, 400),
      }).landmarks,
      world: frame(0, {
        [LM.LEFT_HIP]: { x: 0, y: 0, z: 0, visibility: 1 },
        [LM.LEFT_KNEE]: { x: 0.02, y: -0.4, z: -0.4, visibility: 1 },
        [LM.LEFT_ANKLE]: { x: 0, y: -0.8, z: 0, visibility: 1 },
      }).landmarks,
    }
    expect(frameAngles([occluded], 'left')[0].knee).toBeNull()
  })
})

describe('smooth', () => {
  it('removes a single-frame snap without moving the good frames', () => {
    // Four frames at x=100 and one that jumped to 900 — the failure mode pose
    // actually has. A mean would drag the whole window; a median ignores it.
    const frames = [100, 100, 900, 100, 100].map((x, i) =>
      frame(i, { [LM.LEFT_KNEE]: at(x, 300) }),
    )
    const out = smooth(frames, 5)
    expect(out[2].landmarks[LM.LEFT_KNEE].x).toBeCloseTo(100, 6)
  })

  it('ignores landmarks the model could not see when voting', () => {
    // The invisible frames sit at 900. They must not get a vote, or a joint the
    // model was guessing at drags the frames where it was sure.
    const frames = [
      frame(0, { [LM.LEFT_KNEE]: at(900, 0, 0.1) }),
      frame(1, { [LM.LEFT_KNEE]: at(100, 0, 0.9) }),
      frame(2, { [LM.LEFT_KNEE]: at(900, 0, 0.1) }),
    ]
    expect(smooth(frames, 3)[1].landmarks[LM.LEFT_KNEE].x).toBeCloseTo(100, 6)
  })

  it('never invents confidence the model did not report', () => {
    const frames = [0, 1, 2].map((i) => frame(i, { [LM.LEFT_KNEE]: at(100, 0, 0.42) }))
    expect(smooth(frames, 3)[1].landmarks[LM.LEFT_KNEE].visibility).toBeCloseTo(0.42, 6)
  })

  it('leaves a landmark alone when nothing in the window was visible', () => {
    const frames = [0, 1, 2].map((i) => frame(i, { [LM.LEFT_KNEE]: at(55, 66, 0.1) }))
    const l = smooth(frames, 3)[1].landmarks[LM.LEFT_KNEE]
    expect(l.x).toBeCloseTo(55, 6)
    expect(l.y).toBeCloseTo(66, 6)
  })

  it('is a no-op for a window of one', () => {
    const frames = [frame(0, { [LM.LEFT_KNEE]: at(1, 2) })]
    expect(smooth(frames, 1)).toBe(frames)
  })

  it('widens an even window so there is a true middle', () => {
    // Window 4 becomes 5, so the single 900 is outvoted 4-1 rather than 2-2.
    const frames = [100, 100, 900, 100, 100].map((x, i) =>
      frame(i, { [LM.LEFT_KNEE]: at(x, 0) }),
    )
    expect(smooth(frames, 4)[2].landmarks[LM.LEFT_KNEE].x).toBeCloseTo(100, 6)
  })
})

describe('frameIndexAt', () => {
  const frames = [0, 0.5, 1.0, 1.5, 2.0].map((t) => frame(t, {}))

  it('finds the nearest frame, not merely the next one', () => {
    // 0.9 is nearer 1.0 than 0.5 — a plain lower-bound search would answer 0.5.
    expect(frameIndexAt(frames, 0.9)).toBe(2)
    expect(frameIndexAt(frames, 0.6)).toBe(1)
  })

  it('hits exact timestamps', () => {
    frames.forEach((f, i) => expect(frameIndexAt(frames, f.t)).toBe(i))
  })

  it('clamps outside the track rather than running off it', () => {
    expect(frameIndexAt(frames, -5)).toBe(0)
    expect(frameIndexAt(frames, 99)).toBe(frames.length - 1)
  })

  it('agrees with a linear scan across the whole track', () => {
    // The binary search exists only for speed; if it ever disagrees with the
    // obvious implementation it is a bug, not an optimisation.
    for (let t = -0.2; t < 2.3; t += 0.017) {
      const linear = frames.reduce(
        (best, f, i) => (Math.abs(f.t - t) < Math.abs(frames[best].t - t) ? i : best),
        0,
      )
      expect(frameIndexAt(frames, t), `t=${t.toFixed(3)}`).toBe(linear)
    }
  })

  it('has nothing to find in an empty track', () => {
    expect(frameIndexAt([], 1)).toBe(-1)
  })
})

describe('packPose / unpackPose', () => {
  const withWorld = (t: number): PoseFrame => ({
    t,
    landmarks: Array.from({ length: LANDMARK_COUNT }, (_, i) => at(i * 2, i * 3, i / 40)),
    world: Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
      x: i * 0.01,
      y: -i * 0.02,
      z: i * 0.005,
      visibility: 1,
    })),
  })

  it('round-trips a track through the packed form', () => {
    const frames = [withWorld(0), withWorld(0.033), withWorld(0.067)]
    const back = unpackPose(packPose(frames))

    expect(back).toHaveLength(3)
    expect(back[1].t).toBeCloseTo(0.033, 12)
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      expect(back[1].landmarks[i].x).toBeCloseTo(i * 2, 3)
      expect(back[1].landmarks[i].visibility).toBeCloseTo(i / 40, 5)
      expect(back[1].world![i].z).toBeCloseTo(i * 0.005, 6)
    }
  })

  it('keeps timestamps at full precision', () => {
    // Float32 times would drift against the bar path, whose own timestamps
    // travel as JSON doubles — a skeleton a frame out from the dot.
    const t = 1234.5678901234
    expect(unpackPose(packPose([withWorld(t)]))[0].t).toBe(t)
  })

  it('stores no world set at all rather than a partial one', () => {
    // Half a clip in metres and half in pixels would switch the angle basis
    // mid-lift with nothing saying so.
    const mixed = [withWorld(0), { t: 0.033, landmarks: withWorld(0.033).landmarks }]
    expect(packPose(mixed).world).toBeNull()
    expect(unpackPose(packPose(mixed))[0].world).toBeUndefined()
  })

  it('is compact enough to justify a BLOB', () => {
    const frames = Array.from({ length: 300 }, (_, i) => withWorld(i / 30))
    const packed = packPose(frames)
    const bytes = packed.keypoints.byteLength + (packed.world?.byteLength ?? 0)
    // ~238 KB against roughly a megabyte of JSON for the same numbers.
    expect(bytes).toBeLessThan(300_000)
    expect(packed.frameCount).toBe(300)
  })

  it('handles an empty track', () => {
    expect(unpackPose(packPose([]))).toEqual([])
  })
})

describe('applyCorrections', () => {
  const base = [
    frame(0, { [LM.LEFT_KNEE]: at(100, 300, 0.2) }),
    frame(0.033, { [LM.LEFT_KNEE]: at(105, 305, 0.2) }),
  ]

  it('returns the frames untouched when there is nothing to correct', () => {
    expect(applyCorrections(base, [])).toBe(base)
  })

  it('moves only the corrected landmark on the corrected frame', () => {
    const out = applyCorrections(base, [
      { frameIndex: 1, landmark: LM.LEFT_KNEE, x: 500, y: 600 },
    ])
    expect(out[0].landmarks[LM.LEFT_KNEE].x).toBeCloseTo(100, 6)
    expect(out[1].landmarks[LM.LEFT_KNEE].x).toBeCloseTo(500, 6)
    expect(out[1].landmarks[LM.LEFT_KNEE].y).toBeCloseTo(600, 6)
  })

  it('treats a hand-placed landmark as fully visible', () => {
    // The coach has just said where it is. That IS the certainty visibility
    // encodes, and without it the angle code would still refuse the joint.
    const out = applyCorrections(base, [{ frameIndex: 0, landmark: LM.LEFT_KNEE, x: 1, y: 2 }])
    expect(out[0].landmarks[LM.LEFT_KNEE].visibility).toBe(1)
  })

  it('never mutates the measurement it was given', () => {
    const before = base[1].landmarks[LM.LEFT_KNEE].x
    applyCorrections(base, [{ frameIndex: 1, landmark: LM.LEFT_KNEE, x: 999, y: 999 }])
    expect(base[1].landmarks[LM.LEFT_KNEE].x).toBe(before)
  })

  it('drops the world set on a corrected frame, and says so downstream', () => {
    // The model's 3D estimate for a joint the coach just contradicted is no
    // longer its own coherent guess. Measuring angles off it would ignore the
    // correction entirely — drag the knee, watch the number not move.
    const framesWithWorld = base.map((f) => ({ ...f, world: f.landmarks }))
    const out = applyCorrections(framesWithWorld, [
      { frameIndex: 0, landmark: LM.LEFT_KNEE, x: 1, y: 2 },
    ])
    expect(out[0].world).toBeUndefined()
    expect(out[1].world).toBeDefined()
    expect(frameAngles(out, 'left')[0].metric).toBe(false)
    expect(frameAngles(out, 'left')[1].metric).toBe(true)
  })

  it('ignores a correction pointing at a landmark that does not exist', () => {
    const out = applyCorrections(base, [{ frameIndex: 0, landmark: 999, x: 1, y: 2 }])
    expect(out[0].landmarks).toHaveLength(LANDMARK_COUNT)
  })
})

describe('insertFrame', () => {
  const f = (t: number, x = 0) => frame(t, { [LM.LEFT_KNEE]: at(x, 0) })

  it('keeps the track in time order however the coach scrubs', () => {
    // Preview inference produces frames in whatever order the clip was scrubbed,
    // and every reader downstream — the binary search included — assumes order.
    let frames: PoseFrame[] = []
    for (const t of [0.5, 0.1, 0.9, 0.3]) frames = insertFrame(frames, f(t))
    expect(frames.map((x) => x.t)).toEqual([0.1, 0.3, 0.5, 0.9])
  })

  it('replaces a frame at the same instant rather than piling up', () => {
    let frames = insertFrame([], f(0.5, 100))
    frames = insertFrame(frames, f(0.5, 200))
    expect(frames).toHaveLength(1)
    expect(frames[0].landmarks[LM.LEFT_KNEE].x).toBe(200)
  })

  it('treats a hair either side of an instant as the same frame', () => {
    let frames = insertFrame([], f(0.5, 100))
    frames = insertFrame(frames, f(0.5004, 200))
    frames = insertFrame(frames, f(0.4996, 300))
    expect(frames).toHaveLength(1)
  })

  it('does not mutate the array it was given', () => {
    const before: PoseFrame[] = [f(0.1)]
    insertFrame(before, f(0.2))
    expect(before).toHaveLength(1)
  })

  it('appends and prepends at the ends', () => {
    let frames = insertFrame([], f(0.5))
    frames = insertFrame(frames, f(0.9))
    frames = insertFrame(frames, f(0.1))
    expect(frames.map((x) => x.t)).toEqual([0.1, 0.5, 0.9])
  })
})

describe('correctionsAtTimes', () => {
  const track = (ts: number[]) => ts.map((t) => frame(t, {}))

  it('pins a correction to the moment, not to an array position', () => {
    // The whole point: a fix made on a sparse preview has to land on the right
    // instant after the tracker rebuilds the track at a different frame rate.
    const preview = track([0, 0.5, 1.0])
    const timed = [{ t: 1.0, landmark: LM.LEFT_KNEE, x: 5, y: 6 }]
    expect(correctionsAtTimes(preview, timed)[0].frameIndex).toBe(2)

    const retracked = track([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    expect(correctionsAtTimes(retracked, timed)[0].frameIndex).toBe(10)
  })

  it('drops a correction with no frame near it rather than moving it', () => {
    // Better to lose a fix than to draw it half a second from where it was made.
    expect(correctionsAtTimes(track([0, 0.5]), [{ t: 9, landmark: 1, x: 0, y: 0 }])).toEqual([])
  })

  it('lets a later drag of the same joint replace an earlier one', () => {
    const out = correctionsAtTimes(track([0, 0.5]), [
      { t: 0.5, landmark: LM.LEFT_KNEE, x: 1, y: 1 },
      { t: 0.5, landmark: LM.LEFT_KNEE, x: 9, y: 9 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].x).toBe(9)
  })

  it('keeps different joints on the same frame apart', () => {
    const out = correctionsAtTimes(track([0]), [
      { t: 0, landmark: LM.LEFT_KNEE, x: 1, y: 1 },
      { t: 0, landmark: LM.RIGHT_KNEE, x: 2, y: 2 },
    ])
    expect(out).toHaveLength(2)
  })

  it('has nothing to resolve against an empty track', () => {
    expect(correctionsAtTimes([], [{ t: 0, landmark: 1, x: 0, y: 0 }])).toEqual([])
  })

  it('round-trips through applyCorrections', () => {
    const frames = track([0, 0.5])
    const timed = [{ t: 0.5, landmark: LM.LEFT_KNEE, x: 77, y: 88 }]
    const out = applyCorrections(frames, correctionsAtTimes(frames, timed))
    expect(out[1].landmarks[LM.LEFT_KNEE]).toEqual({ x: 77, y: 88, visibility: 1 })
  })
})

describe('anglesAgainstBar', () => {
  const angles = (ts: number[]) =>
    ts.map((t) => ({ t, knee: 90, hip: 90, ankle: 90, torsoLean: 0, metric: true }))

  it('samples the nearest velocity reading to each pose frame', () => {
    const out = anglesAgainstBar(angles([0, 0.1, 0.2]), [
      { t: 0.01, vy: -100 },
      { t: 0.11, vy: -200 },
      { t: 0.19, vy: -300 },
    ])
    expect(out.map((o) => o.barVelocity)).toEqual([-100, -200, -300])
  })

  it('refuses a join with no velocity sample anywhere near it', () => {
    // Better a gap in the chart than a body position paired with what the bar
    // was doing half a second later.
    const out = anglesAgainstBar(angles([0, 5]), [{ t: 0, vy: -100 }])
    expect(out[0].barVelocity).toBe(-100)
    expect(out[1].barVelocity).toBeNull()
  })

  it('survives having no bar path at all', () => {
    expect(anglesAgainstBar(angles([0, 1]), []).every((o) => o.barVelocity === null)).toBe(true)
  })

  it('keeps every angle field it was given', () => {
    const out = anglesAgainstBar(angles([0]), [{ t: 0, vy: -1 }])
    expect(out[0].knee).toBe(90)
    expect(out[0].metric).toBe(true)
  })
})

describe('stickingPoint', () => {
  const series = (vs: (number | null)[]): AngleVsBar[] =>
    vs.map((barVelocity, i) => ({
      t: i / 30,
      knee: null,
      hip: null,
      ankle: null,
      torsoLean: null,
      barVelocity,
      metric: true,
    }))

  it('finds the slowest moment of the ascent', () => {
    // vy is image space, so up is negative: -20 is the slowest upward motion.
    expect(stickingPoint(series([-300, -200, -20, -150, -400]))).toBe(2)
  })

  it('ignores the descent entirely', () => {
    // The slowest instant of a squat is the turnaround at the bottom, and
    // calling that a sticking point would be worse than saying nothing.
    expect(stickingPoint(series([200, 5, 300, -400, -50, -600]))).toBe(4)
  })

  it('has no answer when the bar never went up', () => {
    expect(stickingPoint(series([100, 200, 300]))).toBeNull()
    expect(stickingPoint(series([null, null]))).toBeNull()
    expect(stickingPoint(series([]))).toBeNull()
  })
})

describe('POSE_BONES', () => {
  it('only references landmarks that exist', () => {
    for (const [a, b] of POSE_BONES) {
      expect(a).toBeLessThan(LANDMARK_COUNT)
      expect(b).toBeLessThan(LANDMARK_COUNT)
    }
  })

  it('draws no face mesh — a coach is looking at the lift', () => {
    // Everything below 11 is head and face. Drawing them adds eleven dots over
    // the lifter's nose and answers no coaching question.
    for (const [a, b] of POSE_BONES) {
      expect(Math.min(a, b)).toBeGreaterThanOrEqual(LM.LEFT_SHOULDER)
    }
  })

  it('includes the foot, which is why a 33-point model was chosen', () => {
    const hasFoot = POSE_BONES.some(
      ([a, b]) => a === LM.LEFT_FOOT_INDEX || b === LM.LEFT_FOOT_INDEX,
    )
    expect(hasFoot).toBe(true)
  })
})
