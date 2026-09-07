import { beforeEach, describe, it, expect } from 'vitest'
import { packPose, unpackPose, LANDMARK_COUNT, type PoseFrame } from 'coachboard-shared/pose'
import { getDb, initializeDatabase } from '../db.js'
import {
  clearPoseCorrection,
  deletePoseTrack,
  getPoseTrack,
  savePoseTrack,
  setPoseCorrection,
} from './poseTrackService.js'

// A pose track is stored as packed binary, so the thing worth testing is that
// what comes back out is what went in — a byte-order or offset mistake here
// would surface as landmarks from the wrong frame, which looks like a bad model
// rather than a bad read.

const ANALYSIS_ID = 'analysis-1'

function poseFrame(t: number, seed: number): PoseFrame {
  return {
    t,
    landmarks: Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
      x: seed * 100 + i,
      y: seed * 200 + i * 2,
      visibility: (i % 10) / 10,
    })),
    world: Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
      x: i * 0.01,
      y: -i * 0.02,
      z: seed * 0.1,
      visibility: 1,
    })),
  }
}

/** An analysis to hang a pose track off — the foreign key needs a real row. */
async function seedAnalysis(id = ANALYSIS_ID) {
  await getDb()
    .insertInto('video_analyses')
    .values({
      id,
      media_id: null,
      athlete_id: null,
      source_label: 'test clip',
      track: JSON.stringify([{ t: 0, x: 1, y: 2 }]),
      calibration: null,
      metrics: null,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute()
}

beforeEach(async () => {
  await initializeDatabase(':memory:')
  await seedAnalysis()
})

describe('savePoseTrack / getPoseTrack', () => {
  it('round-trips a track through the database unchanged', async () => {
    const frames = [poseFrame(0, 1), poseFrame(0.033, 2), poseFrame(0.067, 3)]
    await savePoseTrack(ANALYSIS_ID, packPose(frames))

    const stored = await getPoseTrack(ANALYSIS_ID)
    expect(stored).not.toBeNull()
    expect(stored!.frameCount).toBe(3)
    expect(stored!.landmarkCount).toBe(LANDMARK_COUNT)

    const back = unpackPose(stored!)
    expect(back[2].t).toBeCloseTo(0.067, 12)
    expect(back[2].landmarks[5].x).toBeCloseTo(305, 3)
    expect(back[2].world![5].z).toBeCloseTo(0.3, 5)
  })

  it('has nothing to return for an analysis with no track', async () => {
    expect(await getPoseTrack(ANALYSIS_ID)).toBeNull()
  })

  it('replaces a track on a re-run rather than accumulating', async () => {
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 1), poseFrame(0.033, 2)]))
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 9)]))

    const stored = await getPoseTrack(ANALYSIS_ID)
    expect(stored!.frameCount).toBe(1)
    expect(unpackPose(stored!)[0].landmarks[0].x).toBeCloseTo(900, 3)
  })

  it('stores a track that has no world landmarks', async () => {
    const flat = [{ t: 0, landmarks: poseFrame(0, 1).landmarks }]
    await savePoseTrack(ANALYSIS_ID, packPose(flat))
    const stored = await getPoseTrack(ANALYSIS_ID)
    expect(stored!.world).toBeNull()
    expect(unpackPose(stored!)[0].world).toBeUndefined()
  })

  it('refuses arrays that disagree with the counts', async () => {
    const packed = packPose([poseFrame(0, 1)])
    await expect(
      savePoseTrack(ANALYSIS_ID, { ...packed, frameCount: 5 }),
    ).rejects.toThrow(/frame and landmark counts/)
    await expect(
      savePoseTrack(ANALYSIS_ID, { ...packed, times: new Float64Array(9) }),
    ).rejects.toThrow(/frame count/)
  })

  it('refuses an empty track', async () => {
    await expect(savePoseTrack(ANALYSIS_ID, packPose([]))).rejects.toThrow(/at least one frame/)
  })
})

describe('pose corrections', () => {
  beforeEach(async () => {
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 1), poseFrame(0.033, 2)]))
  })

  it('records a hand-placed landmark and returns it with the track', async () => {
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 1, landmark: 25, x: 500, y: 600 })
    const stored = await getPoseTrack(ANALYSIS_ID)
    expect(stored!.corrections).toEqual([{ frameIndex: 1, landmark: 25, x: 500, y: 600 }])
  })

  it('moves an existing correction rather than adding a second', async () => {
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 1, landmark: 25, x: 500, y: 600 })
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 1, landmark: 25, x: 111, y: 222 })
    const stored = await getPoseTrack(ANALYSIS_ID)
    expect(stored!.corrections).toHaveLength(1)
    expect(stored!.corrections[0].x).toBe(111)
  })

  it('takes a correction back', async () => {
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 0, landmark: 25, x: 1, y: 2 })
    await clearPoseCorrection(ANALYSIS_ID, 0, 25)
    expect((await getPoseTrack(ANALYSIS_ID))!.corrections).toEqual([])
  })

  it('refuses a landmark index that is not a real landmark', async () => {
    await expect(
      setPoseCorrection(ANALYSIS_ID, { frameIndex: 0, landmark: 99, x: 1, y: 2 }),
    ).rejects.toThrow(/landmark/)
  })

  /**
   * The one that protects the coach's work. Re-running the model must not
   * silently destroy a fix — "what the model saw" and "what the coach said it
   * was" are different things and both have to survive.
   */
  it('KEEPS corrections when the model is re-run over the same frames', async () => {
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 1, landmark: 25, x: 500, y: 600 })
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 7), poseFrame(0.033, 8)]))
    expect((await getPoseTrack(ANALYSIS_ID))!.corrections).toHaveLength(1)
  })

  it('drops only the corrections a shorter re-run left pointing past the end', async () => {
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 0, landmark: 25, x: 1, y: 2 })
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 1, landmark: 25, x: 3, y: 4 })
    // Re-tracked to a single frame: frame 1 is no longer a moment that exists.
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 7)]))
    const stored = await getPoseTrack(ANALYSIS_ID)
    expect(stored!.corrections).toEqual([{ frameIndex: 0, landmark: 25, x: 1, y: 2 }])
  })
})

describe('lifetime', () => {
  it('goes when the analysis goes', async () => {
    // CASCADE, unlike video_analyses' own parents: an analysis outlives the clip
    // it came from, but a pose track is derived from the analysis and means
    // nothing without it.
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 1)]))
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 0, landmark: 25, x: 1, y: 2 })

    await getDb().deleteFrom('video_analyses').where('id', '=', ANALYSIS_ID).execute()

    expect(await getPoseTrack(ANALYSIS_ID)).toBeNull()
    const orphans = await getDb()
      .selectFrom('pose_corrections')
      .selectAll()
      .where('analysis_id', '=', ANALYSIS_ID)
      .execute()
    expect(orphans).toEqual([])
  })

  it('can be removed on its own, leaving the analysis alone', async () => {
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 1)]))
    await setPoseCorrection(ANALYSIS_ID, { frameIndex: 0, landmark: 25, x: 1, y: 2 })
    await deletePoseTrack(ANALYSIS_ID)

    expect(await getPoseTrack(ANALYSIS_ID)).toBeNull()
    const analysis = await getDb()
      .selectFrom('video_analyses')
      .selectAll()
      .where('id', '=', ANALYSIS_ID)
      .executeTakeFirst()
    expect(analysis).toBeDefined()
  })

  it('keeps two analyses' + ' tracks apart', async () => {
    await seedAnalysis('analysis-2')
    await savePoseTrack(ANALYSIS_ID, packPose([poseFrame(0, 1)]))
    await savePoseTrack('analysis-2', packPose([poseFrame(0, 5)]))

    expect(unpackPose((await getPoseTrack(ANALYSIS_ID))!)[0].landmarks[0].x).toBeCloseTo(100, 3)
    expect(unpackPose((await getPoseTrack('analysis-2'))!)[0].landmarks[0].x).toBeCloseTo(500, 3)
  })
})
