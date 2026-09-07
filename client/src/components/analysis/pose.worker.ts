/// <reference lib="webworker" />
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { toVideoPixels, type Landmark } from 'coachboard-shared/pose'

// ---------------------------------------------------------------------------
// Pose inference, off the main thread (Feature 11e-1).
//
// Same split as tracker.core.ts / tracker.worker.ts next door: everything that
// can be reasoned about without a browser lives in shared/pose.ts and is tested
// under the node-only runner; this file is the part that can only run in a
// worker, and it is kept as thin as it can be.
//
// A worker for the same reason the tracker uses one — the WASM runtime is ~12 MB
// and compiling it on the main thread freezes the window — plus one this feature
// adds: inference is ~32 ms a frame, which on the main thread would eat the
// animation frame the overlay is drawn in.
//
// THREE THINGS HERE WERE MEASURED, NOT ASSUMED (11e-0, see ROADMAP):
//
//  - The model is `lite`, not `full`. `full` costs ~46 ms a frame single-threaded
//    against a ~33 ms budget; `lite` runs at ~32 ms with identical detection on
//    real footage. There are no WASM threads to fall back on — COOP/COEP was
//    rejected because require-corp breaks the Discord avatars in the inbox.
//  - The fileset is VENDORED. The app's CSP is `default-src 'self' ...`, so the
//    usual FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/...') dies
//    with no useful error.
//  - The loader is chosen at RUNTIME, see below.
// ---------------------------------------------------------------------------

const WASM_BASE = '/vendor/mediapipe/wasm'
const MODEL_BASE = '/vendor/mediapipe/models'

/**
 * Which landmark model to load.
 *
 * ONLY `lite` IS VENDORED. `full` was measured twice and rejected twice: at
 * ~46 ms a frame against a ~33 ms tracking budget, and then on accuracy, where
 * it scored 0.888 lower-body visibility against lite's 0.878 — inside the noise
 * — and worse again at a larger input. It is not in the repo.
 *
 * The type stays open because the preview has no frame budget and a future clip
 * might show a real difference. Asking for anything but `lite` today means
 * re-vendoring the `.task` from @mediapipe/tasks-vision first: a model that is
 * not there 404s, and the loader reports that as a corrupt file rather than a
 * missing one.
 */
export type PoseModel = 'lite' | 'full'

/**
 * Whether this worker was built as a classic script or an ES module.
 *
 * MediaPipe ships two WASM loaders: the classic one calls `importScripts`, the
 * module one uses a dynamic `import()`. Pick the wrong one and initialisation
 * hangs or throws — and which is right depends on how Vite emitted this file,
 * which differs between dev (module) and build (IIFE). Pinning `worker.format`
 * globally would fix it too, and would put the opencv tracker at risk; that
 * mismatch has already broken tracking once. Asking the runtime costs a line:
 * only a classic worker scope has importScripts. Both paths were measured and
 * land within 1 ms of each other.
 */
const isClassicWorker =
  typeof (self as unknown as { importScripts?: unknown }).importScripts === 'function'

/** VIDEO tracks between frames; IMAGE treats each one on its own. See init. */
export type PoseMode = 'VIDEO' | 'IMAGE'

type Incoming =
  | { type: 'init'; videoWidth: number; videoHeight: number; mode: PoseMode; model: PoseModel }
  | { type: 'frame'; t: number; width: number; height: number; data: ArrayBuffer }
  | { type: 'close' }

type Outgoing =
  | { type: 'ready' }
  | { type: 'pose'; t: number; landmarks: Landmark[] | null; world: Landmark[] | null }
  | { type: 'error'; message: string }
  | { type: 'closed' }

const post = (message: Outgoing) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message)

let landmarker: PoseLandmarker | null = null
/** Kept from init so landmarks leave here in ORIGINAL VIDEO PIXELS — see shared/pose.ts. */
let videoWidth = 0
let videoHeight = 0

/**
 * MediaPipe rejects a timestamp that does not advance, and variable-frame-rate
 * phone video really does present two frames with the same mediaTime. Tracked in
 * whole milliseconds because that is the unit the API takes.
 */
let lastTimestamp = -1
/** Which mode the landmarker was created in — detect() must match it. */
let running: PoseMode = 'VIDEO'

async function init(width: number, height: number, mode: PoseMode, model: PoseModel): Promise<void> {
  // One instance, closed on `close`. The WASM heap is not reclaimed by dropping
  // the reference and creating a new one, and render-process-gone is already
  // logged in main.ts — this is a plausible way to start seeing it.
  if (landmarker) landmarker.close()

  videoWidth = width
  videoHeight = height
  lastTimestamp = -1
  running = mode

  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE, !isClassicWorker)
  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${MODEL_BASE}/pose_landmarker_${model}.task`,
      // CPU: there is no GPU delegate worth trusting across the machines this
      // ships to, and the 11e-0 budget was measured on CPU.
      delegate: 'CPU',
    },
    /**
     * VIDEO for a tracking pass, IMAGE for the preview, and the difference
     * matters more than the speed does.
     *
     * VIDEO is why MediaPipe was chosen over MoveNet: it runs the detector once
     * and then reuses the region of interest, re-detecting only when it loses
     * the lifter. That is exactly right for a pass that plays a clip forwards.
     *
     * It is exactly WRONG for a coach scrubbing. VIDEO mode carries that region
     * between calls and requires timestamps that only ever increase — so a jump
     * backwards feeds it an image from somewhere else entirely while the clock
     * says a millisecond passed, and it tracks from a region the lifter is no
     * longer in. The skeleton comes back stale, or bent onto the wrong part of
     * the frame, and self-corrects only after several frames the preview never
     * runs. IMAGE mode treats every frame independently: slower per call,
     * correct at any point in the clip, in any order.
     */
    runningMode: mode,
    // One lifter. A spotter or a passer-by behind the rack is not the subject,
    // and picking between two skeletons is a problem worth not having.
    numPoses: 1,
  })
  post({ type: 'ready' })
}

function detect(t: number, width: number, height: number, data: ArrayBuffer): void {
  if (!landmarker) throw new Error('Pose worker used before init')

  // Rebuilt here rather than sent as an ImageData because the buffer is
  // transferred, not copied — the same rule the bar-path tracker follows, and
  // the reason nothing here holds a frame after it is done with it.
  const image = new ImageData(new Uint8ClampedArray(data), width, height)

  // detectForVideo and detect are not interchangeable — the landmarker refuses
  // the one it was not created for.
  let result
  if (running === 'IMAGE') {
    result = landmarker.detect(image)
  } else {
    const timestamp = Math.max(Math.round(t * 1000), lastTimestamp + 1)
    lastTimestamp = timestamp
    result = landmarker.detectForVideo(image, timestamp)
  }
  const found = result.landmarks?.[0] ?? null
  const world = result.worldLandmarks?.[0] ?? null
  post({
    type: 'pose',
    t,
    // Converted on the way out, against the VIDEO's dimensions rather than the
    // frame's: MediaPipe normalises against whatever it was fed, so this is what
    // makes a track captured at 256 comparable with a bar path tracked at 320,
    // and re-runnable at a different width without invalidating what is stored.
    landmarks: found ? toVideoPixels(found, videoWidth, videoHeight) : null,
    // Already metres, hip-centred, and NOT normalised — so they must not go
    // through toVideoPixels. These are what joint angles are measured from,
    // because the image-space ones lose the depth a squat filmed from the front
    // does most of its bending in. See PoseFrame.world.
    world: world
      ? world.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 }))
      : null,
  })
}

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data
  try {
    if (message.type === 'init') {
      await init(message.videoWidth, message.videoHeight, message.mode ?? 'VIDEO', message.model ?? 'lite')
    }
    else if (message.type === 'frame') detect(message.t, message.width, message.height, message.data)
    else if (message.type === 'close') {
      landmarker?.close()
      landmarker = null
      lastTimestamp = -1
      post({ type: 'closed' })
    }
  } catch (err) {
    // Reported rather than thrown: an unhandled rejection in a worker surfaces
    // as a bare "error" event with no message, which is indistinguishable from
    // the worker having failed to load at all.
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
