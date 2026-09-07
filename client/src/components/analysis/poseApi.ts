import {
  applyCorrections,
  packPose,
  unpackPose,
  type PoseCorrection,
  type PoseFrame,
} from 'coachboard-shared/pose'

// ---------------------------------------------------------------------------
// Reading and writing a saved skeleton (Feature 11e-4).
//
// The packing lives in shared/pose.ts and is tested there; this is only the
// transport. Coordinates travel as plain number arrays and are packed into
// Float32 BLOBs at the server's storage boundary — JSON over localhost costs a
// few hundred kilobytes on a save the coach explicitly asked for, and a binary
// body would mean a second content type for one route.
// ---------------------------------------------------------------------------

export interface LoadedPose {
  /** The model's own output, corrections NOT yet applied. */
  measured: PoseFrame[]
  /** The coach's fixes, kept separate so they can be layered or taken back. */
  corrections: PoseCorrection[]
  /** What the measurement looks like with the fixes on top — what to draw. */
  frames: PoseFrame[]
}

/** Stores a track against a saved analysis. Silent about failure; see the call site. */
export async function savePose(analysisId: string, frames: PoseFrame[]): Promise<void> {
  if (frames.length === 0) return
  const packed = packPose(frames)
  const res = await fetch(`/api/analysis/${encodeURIComponent(analysisId)}/pose`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frameCount: packed.frameCount,
      landmarkCount: packed.landmarkCount,
      keypoints: Array.from(packed.keypoints),
      world: packed.world ? Array.from(packed.world) : null,
      times: Array.from(packed.times),
    }),
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

  const body = await res.json()
  const measured = unpackPose({
    frameCount: body.frameCount,
    landmarkCount: body.landmarkCount,
    keypoints: Float32Array.from(body.keypoints),
    world: body.world ? Float32Array.from(body.world) : null,
    times: Float64Array.from(body.times),
  })
  const corrections: PoseCorrection[] = body.corrections ?? []
  return { measured, corrections, frames: applyCorrections(measured, corrections) }
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
