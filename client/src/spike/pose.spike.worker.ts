/// <reference lib="webworker" />
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'

// ---------------------------------------------------------------------------
// Feature 11e-0 spike worker — MEASUREMENT ONLY, not the shipping worker.
//
// The question this exists to answer is whether pose inference fits inside the
// ~33 ms a frame gets while the bar-path tracker is already reading the clip at
// 1x playback. If it does, pose is free: the coach waits exactly as long as
// tracking takes today and gets a skeleton for it. If it does not, the whole
// feature needs a WebCodecs decoder and a different plan.
//
// Everything here is deliberately throwaway. What survives the spike is the
// numbers, not this file.
//
// Two app-specific constraints are baked in and are the reason this runs in the
// real app rather than a benchmark harness:
//
//  - No CDN. The app's CSP is `default-src 'self' ... http://localhost:*`, so
//    the usual FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/...')
//    fails with no useful error. The fileset is vendored under
//    client/public/vendor/mediapipe/ exactly as opencv.js is.
//  - No WASM threads. COOP/COEP was rejected because `require-corp` breaks the
//    Discord avatars in the inbox, so there is no SharedArrayBuffer and MediaPipe
//    runs single-threaded. That is the single biggest constraint on the feature
//    and it is why these numbers cannot be compared against published ones.
// ---------------------------------------------------------------------------

const WASM_BASE = '/vendor/mediapipe/wasm'
const MODEL_BASE = '/vendor/mediapipe/models'

/**
 * Whether this worker was built as a classic script or an ES module.
 *
 * MediaPipe ships two WASM loaders: the classic one calls `importScripts`, the
 * module one uses a dynamic `import()`. Pick the wrong one and initialisation
 * hangs or throws — and which one is right depends on how Vite happened to emit
 * this file, which differs between dev (module) and build (IIFE). Rather than
 * pinning `worker.format` globally and re-testing the opencv tracker that has
 * already been broken once by exactly that mismatch, ask the runtime: only a
 * classic worker scope has importScripts.
 */
const isClassicWorker = typeof (self as unknown as { importScripts?: unknown }).importScripts === 'function'

export type SpikeModel = 'full' | 'lite'

type Incoming =
  | { type: 'init'; model: SpikeModel }
  | { type: 'frame'; t: number; width: number; height: number; data: ArrayBuffer }
  | { type: 'close' }

type Outgoing =
  | { type: 'ready'; loadMs: number; useModule: boolean }
  | {
      type: 'result'
      t: number
      /** Wall-clock cost of detectForVideo alone — the number the spike exists for. */
      inferMs: number
      /** Landmarks in 0-1 normalised space, or null when no person was found. */
      landmarks: { x: number; y: number; visibility: number }[] | null
    }
  | { type: 'error'; message: string }

const post = (message: Outgoing, transfer?: Transferable[]) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer ?? [])

let landmarker: PoseLandmarker | null = null

/**
 * MediaPipe rejects a timestamp that does not advance, and variable-frame-rate
 * phone video can present two frames with the same mediaTime. Tracked in whole
 * milliseconds because that is the unit the API takes.
 */
let lastTimestamp = -1

async function init(model: SpikeModel): Promise<void> {
  const started = performance.now()
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE, !isClassicWorker)
  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${MODEL_BASE}/pose_landmarker_${model}.task`,
      // CPU because there is no GPU delegate worth trusting across the machines
      // this ships to, and because a GPU number here would not be the number the
      // feature actually gets.
      delegate: 'CPU',
    },
    // The reason MediaPipe was chosen over MoveNet: VIDEO mode runs the detector
    // once and then reuses the region of interest, re-detecting only when it
    // loses the subject. On a 300-frame clip that is the dominant cost.
    runningMode: 'VIDEO',
    numPoses: 1,
    // Left at defaults on purpose. Tuning these would make the timings look
    // better and tell us nothing about what the feature would really cost.
  })
  post({ type: 'ready', loadMs: performance.now() - started, useModule: !isClassicWorker })
}

function detect(t: number, width: number, height: number, data: ArrayBuffer): void {
  if (!landmarker) throw new Error('Landmarker not ready')

  // Rebuilt here rather than sent as an ImageData because the buffer is
  // transferred, not copied — the same rule the bar-path tracker follows.
  const image = new ImageData(new Uint8ClampedArray(data), width, height)

  const timestamp = Math.max(Math.round(t * 1000), lastTimestamp + 1)
  lastTimestamp = timestamp

  const started = performance.now()
  const result = landmarker.detectForVideo(image, timestamp)
  const inferMs = performance.now() - started

  const found = result.landmarks?.[0] ?? null
  post({
    type: 'result',
    t,
    inferMs,
    landmarks: found
      ? found.map((l) => ({ x: l.x, y: l.y, visibility: l.visibility ?? 0 }))
      : null,
  })
}

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data
  try {
    if (message.type === 'init') await init(message.model)
    else if (message.type === 'frame') detect(message.t, message.width, message.height, message.data)
    else if (message.type === 'close') {
      // The WASM heap is not reclaimed by dropping the reference and creating a
      // new one, so every model swap in the matrix below must close first.
      landmarker?.close()
      landmarker = null
      lastTimestamp = -1
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
