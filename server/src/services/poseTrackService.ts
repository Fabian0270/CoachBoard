import {
  LANDMARK_COUNT,
  FLOATS_PER_LANDMARK,
  type PackedPose,
  type PoseCorrection,
} from 'coachboard-shared/pose'
import { getDb } from '../db.js'

// ---------------------------------------------------------------------------
// Storing a lifter's skeleton (Feature 11e-4).
//
// The measurement and the coach's edits live in two tables and are never merged
// on the way in. Corrections are layered on READ (applyCorrections in
// shared/pose.ts), so re-running the model replaces what the model saw without
// touching what the coach said — and the two stay distinguishable forever.
//
// Coordinates are packed Float32Arrays rather than JSON: a 300-frame track is
// ~238 KB packed against roughly a megabyte of text, and it comes back without
// building thirty thousand objects. See packPose.
// ---------------------------------------------------------------------------

/** Which model produced a track, so a re-run is comparable with what it replaced. */
export const POSE_MODEL = 'mediapipe-pose-lite@1.0.1'

export interface StoredPose extends PackedPose {
  model: string
  corrections: PoseCorrection[]
}

/**
 * Typed arrays travel to SQLite as Buffers and back again.
 *
 * The copy in `toBuffer` is not optional. `Buffer.from(view.buffer)` would take
 * the WHOLE backing ArrayBuffer, ignoring byteOffset and length — fine for an
 * array that owns its buffer, silently wrong for a subarray, and the kind of
 * thing that only shows up as coordinates from the wrong frame.
 */
const toBuffer = (view: Float32Array | Float64Array): Buffer =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength)

/**
 * Copied out rather than viewed in place, because better-sqlite3 hands back
 * Buffers that may be pooled slices of a larger allocation — and an unaligned
 * byteOffset would make the typed-array constructor throw outright.
 */
function toFloat32(buf: Buffer): Float32Array {
  const copy = new ArrayBuffer(buf.byteLength)
  Buffer.from(copy).set(buf)
  return new Float32Array(copy)
}

function toFloat64(buf: Buffer): Float64Array {
  const copy = new ArrayBuffer(buf.byteLength)
  Buffer.from(copy).set(buf)
  return new Float64Array(copy)
}

/** The stored track for one analysis, corrections included, or null if none. */
export async function getPoseTrack(analysisId: string): Promise<StoredPose | null> {
  const db = getDb()
  const row = await db
    .selectFrom('pose_tracks')
    .selectAll()
    .where('analysis_id', '=', analysisId)
    .executeTakeFirst()
  if (!row) return null

  const corrections = await db
    .selectFrom('pose_corrections')
    .select(['frame_index', 'landmark', 'x', 'y'])
    .where('analysis_id', '=', analysisId)
    .execute()

  return {
    model: row.model,
    frameCount: row.frame_count,
    landmarkCount: row.landmark_count,
    keypoints: toFloat32(row.keypoints),
    world: row.world ? toFloat32(row.world) : null,
    times: toFloat64(row.times),
    corrections: corrections.map((c) => ({
      frameIndex: c.frame_index,
      landmark: c.landmark,
      x: c.x,
      y: c.y,
    })),
  }
}

/**
 * Records a track, replacing whatever was there.
 *
 * Corrections are deliberately LEFT ALONE on a re-run. A coach who re-tracks a
 * clip has not withdrawn their opinion about where the knee was, and silently
 * discarding it is exactly the destruction this table exists to prevent. They
 * are keyed by frame index, so a re-run at a different frame rate can land them
 * on the wrong frames — which is why `frame_count` is stored and checked below.
 */
export async function savePoseTrack(
  analysisId: string,
  packed: PackedPose,
  model = POSE_MODEL,
): Promise<void> {
  if (packed.frameCount <= 0) throw new Error('A pose track needs at least one frame')
  const expected = packed.frameCount * packed.landmarkCount * FLOATS_PER_LANDMARK
  if (packed.keypoints.length !== expected) {
    throw new Error('Keypoint data does not match the frame and landmark counts')
  }
  if (packed.world && packed.world.length !== expected) {
    throw new Error('World landmark data does not match the frame and landmark counts')
  }
  if (packed.times.length !== packed.frameCount) {
    throw new Error('Timestamp data does not match the frame count')
  }

  const db = getDb()
  const values = {
    analysis_id: analysisId,
    model,
    frame_count: packed.frameCount,
    landmark_count: packed.landmarkCount,
    keypoints: toBuffer(packed.keypoints),
    world: packed.world ? toBuffer(packed.world) : null,
    times: toBuffer(packed.times),
    created_at: new Date().toISOString(),
  }

  await db
    .insertInto('pose_tracks')
    .values(values)
    .onConflict((oc) =>
      oc.column('analysis_id').doUpdateSet({
        model: values.model,
        frame_count: values.frame_count,
        landmark_count: values.landmark_count,
        keypoints: values.keypoints,
        world: values.world,
        times: values.times,
        created_at: values.created_at,
      }),
    )
    .execute()

  // A re-run with a different number of frames leaves corrections pointing at
  // frames that no longer mean the same moment. Dropping the ones past the end
  // is the least wrong thing available: keeping them would draw the coach's fix
  // at a time they never looked at.
  await db
    .deleteFrom('pose_corrections')
    .where('analysis_id', '=', analysisId)
    .where('frame_index', '>=', packed.frameCount)
    .execute()
}

/** Records or moves one hand-placed landmark. */
export async function setPoseCorrection(
  analysisId: string,
  correction: PoseCorrection,
): Promise<void> {
  const { frameIndex, landmark, x, y } = correction
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new Error('Bad frame index')
  if (!Number.isInteger(landmark) || landmark < 0 || landmark >= LANDMARK_COUNT) {
    throw new Error('Bad landmark index')
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Bad coordinates')

  await getDb()
    .insertInto('pose_corrections')
    .values({ analysis_id: analysisId, frame_index: frameIndex, landmark, x, y })
    .onConflict((oc) =>
      oc.columns(['analysis_id', 'frame_index', 'landmark']).doUpdateSet({ x, y }),
    )
    .execute()
}

/** Takes one correction back, returning that landmark to what the model said. */
export async function clearPoseCorrection(
  analysisId: string,
  frameIndex: number,
  landmark: number,
): Promise<void> {
  await getDb()
    .deleteFrom('pose_corrections')
    .where('analysis_id', '=', analysisId)
    .where('frame_index', '=', frameIndex)
    .where('landmark', '=', landmark)
    .execute()
}

/** Drops a track and its corrections. Used when a coach turns pose off for a saved set. */
export async function deletePoseTrack(analysisId: string): Promise<void> {
  const db = getDb()
  await db.deleteFrom('pose_corrections').where('analysis_id', '=', analysisId).execute()
  await db.deleteFrom('pose_tracks').where('analysis_id', '=', analysisId).execute()
}
