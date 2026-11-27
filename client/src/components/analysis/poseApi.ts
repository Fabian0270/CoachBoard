import {
  LANDMARK_COUNT,
  POSE_WIRE_TYPE,
  applyCorrections,
  decodePoseTrack,
  encodePoseTrack,
  packPose,
  unpackPose,
  type PoseCorrection,
  type PoseFrame,
} from 'coachboard-shared/pose'
import { displayPose } from 'coachboard-shared/poseRefine'

// ---------------------------------------------------------------------------
// Reading and writing a saved skeleton (Feature 11e-4).
//
// The packing lives in shared/pose.ts and is tested there; this is only the
// transport. The track travels packed in both directions (encodePoseTrack): it
// used to be JSON number arrays, and parsing those blocked the server — which
// is Electron's main process, i.e. the whole app — for as long as a second on
// a long clip.
// ---------------------------------------------------------------------------

export interface LoadedPose {
  /** The model's own output, unfiltered and with corrections NOT yet applied. */
  measured: PoseFrame[]
  /** The coach's fixes, kept separate so they can be layered or taken back. */
  corrections: PoseCorrection[]
  /** Legs rebuilt where needed and jitter-filtered, without the fixes (displayPose). */
  display: PoseFrame[]
  /** `display` with the fixes on top — what to draw and measure from. */
  frames: PoseFrame[]
}

/** Stores a track against a saved analysis. Silent about failure; see the call site. */
export async function savePose(analysisId: string, frames: PoseFrame[]): Promise<void> {
  if (frames.length === 0) return
  const packed = packPose(frames)
  const res = await fetch(`/api/analysis/${encodeURIComponent(analysisId)}/pose`, {
    method: 'PUT',
    headers: { 'Content-Type': POSE_WIRE_TYPE },
    // The encoder allocates exactly the bytes it writes, so its buffer is the body.
    body: encodePoseTrack(packed).buffer as ArrayBuffer,
  })
  if (!res.ok) throw new Error('Could not save the skeleton')
}

/** The stored track for an analysis, or null when pose was never run on it. */
export async function loadPose(analysisId: string): Promise<LoadedPose | null> {
  const res = await fetch(`/api/analysis/${encodeURIComponent(analysisId)}/pose`)
  // 404 is the ordinary case — most analyses have no skeleton — so it is a null
  // rather than something to report.
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Could not load the skeleton')

  const { packed, meta } = decodePoseTrack(new Uint8Array(await res.arrayBuffer()), {
    // Generous: this only guards against reading a damaged body, the server's
    // own caps decided what could be stored.
    maxFrames: 1_000_000,
    maxLandmarks: Math.max(64, LANDMARK_COUNT),
  })
  const measured = unpackPose(packed)
  const corrections: PoseCorrection[] = (meta as { corrections?: PoseCorrection[] }).corrections ?? []
  // Rebuilt and smoothed for display, raw in `measured`. What was stored is the
  // measurement; the leg rebuild and the median filter are reconstructions, so
  // they are applied on the way OUT rather than baked into the row — the same
  // split the corrections use. Corrections go on last so a hand-placed joint
  // wins over both. One pass on load, not per frame.
  const display = displayPose(measured)
  return { measured, corrections, display, frames: applyCorrections(display, corrections) }
}

/** Records or moves one hand-placed landmark. */
export async function putCorrection(
  analysisId: string,
  correction: PoseCorrection,
): Promise<void> {
  const res = await fetch(`/api/analysis/${encodeURIComponent(analysisId)}/pose/corrections`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(correction),
  })
  if (!res.ok) throw new Error('Could not save that correction')
}

/** Returns one landmark to whatever the model said it was. */
export async function deleteCorrection(
  analysisId: string,
  frameIndex: number,
  landmark: number,
): Promise<void> {
  await fetch(
    `/api/analysis/${encodeURIComponent(analysisId)}/pose/corrections/${frameIndex}/${landmark}`,
    { method: 'DELETE' },
  )
}
