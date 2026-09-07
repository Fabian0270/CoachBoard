import { useCallback, useEffect, useRef, useState } from 'react'
import PoseWorker from './pose.worker?worker'
import type { PoseMode, PoseModel } from './pose.worker'
import type { Frame } from './tracker.core'
import { insertFrame, type Landmark, type PoseFrame } from 'coachboard-shared/pose'

// ---------------------------------------------------------------------------
// Owns the pose worker for one analysis page (Feature 11e).
//
// Deliberately a separate worker and a separate hook from useTracker, rather
// than one worker doing both. Three reasons, in order of how much they cost to
// get wrong:
//
//  - They must not block each other. Two runtimes on one thread would serialise
//    ~32 ms of pose behind every optical-flow step, and the fan-out in
//    captureFrames only pays off if the two run at the same time.
//  - Pose is optional and the bar path is not. A skeleton that fails to load
//    must leave tracking working; the two failing together would be a
//    regression in the feature that already ships.
//  - One WASM runtime per worker is what each library expects, and both are big
//    enough that a compile on the wrong thread is visible as a freeze.
// ---------------------------------------------------------------------------

export type PoseStatus = 'idle' | 'loading' | 'ready' | 'error'

/** A pose run that frames are fed into as they are decoded. */
export interface PoseStream {
  /** Feeds one frame. Resolves when that frame has been read, landmarks or not. */
  push: (frame: Frame) => Promise<void>
  /**
   * Every frame read so far, in TIME order — a getter, because the array is
   * replaced on each arrival rather than mutated.
   *
   * Order cannot be assumed from arrival order. A tracking pass plays the clip
   * forwards, but a preview runs on whatever frame the coach has scrubbed to,
   * and everything downstream (the binary-search seek, the angle series, the
   * packing) needs time order.
   */
  readonly frames: PoseFrame[]
  /** Releases the worker's model state. Safe to call more than once. */
  close: () => void
}

export interface OpenPoseOptions {
  videoWidth: number
  videoHeight: number
  /**
   * VIDEO for a tracking pass, IMAGE for the preview.
   *
   * VIDEO reuses the region of interest between frames, which is right for a
   * clip being played forwards and wrong for a coach scrubbing — see the note
   * on runningMode in pose.worker.ts.
   */
  mode: PoseMode
  /**
   * Which landmark model. Defaults to lite, and measurement says leave it there:
   * on real squat footage full scored 0.888 lower-body visibility against lite's
   * 0.878 — inside the noise — while costing 9.4 MB in every installer and every
   * auto-update. Kept as an option because the preview has no frame budget, so
   * the day a clip shows a real difference this is one word.
   */
  model?: PoseModel
  /**
   * Frames already read, carried into the new stream.
   *
   * Switching the skeleton off and on again would otherwise throw away
   * everything the preview had found, and take the frames the coach's
   * corrections are pinned to with it. A tracking run passes nothing, because
   * that pass rebuilds the track.
   */
  seed?: PoseFrame[]
}

/** Give up on a single frame rather than let one stall the whole capture. */
const FRAME_TIMEOUT_MS = 10_000

export function usePose(): {
  status: PoseStatus
  error: string | null
  /**
   * Loads the model. Deliberately NOT called on mount, unlike the tracker's:
   * the model is 5.8 MB and most visits to this page never turn pose on, so it
   * is paid for when the coach asks for it.
   *
   * `seed` carries frames already read into the new stream. Switching the
   * skeleton off and on again would otherwise throw away everything the preview
   * had found, and take the frames the coach's corrections are pinned to with
   * it. A tracking run passes nothing, because that pass rebuilds the track.
   */
  open: (opts: OpenPoseOptions) => Promise<PoseStream>
} {
  const workerRef = useRef<Worker | null>(null)
  const [status, setStatus] = useState<PoseStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  /** Resolves the frame currently in the worker. Only ever one — see captureFrames. */
  const frameWaiter = useRef<((landmarks: Landmark[] | null) => void) | null>(null)
  const readyWaiter = useRef<((ok: boolean) => void) | null>(null)

  /**
   * Shuts down the current worker.
   *
   * `only` makes it a no-op unless that specific worker is still the live one.
   * Without it a stream's close() would terminate WHATEVER worker happens to be
   * current, and the preview and the tracking pass hand over in exactly the
   * order that goes wrong: clicking Track opens the tracking stream, and React
   * then runs the preview effect's cleanup — which would have killed the
   * tracking worker that had just replaced it. Pose would die silently the
   * moment the coach started a run, which is the worst possible time.
   */
  const teardown = useCallback((only?: Worker) => {
    if (only && workerRef.current !== only) return
    workerRef.current?.terminate()
    workerRef.current = null
    // Settle rather than drop: an in-flight capture otherwise waits forever on a
    // promise nothing will ever answer.
    frameWaiter.current?.(null)
    frameWaiter.current = null
    readyWaiter.current?.(false)
    readyWaiter.current = null
  }, [])

  // Leaving the page must free the model. The WASM heap is not small and it is
  // not reclaimed by dropping the reference.
  // Unscoped on purpose: leaving the page frees whatever is running.
  useEffect(() => () => teardown(), [teardown])

  const open = useCallback(
    async ({ videoWidth, videoHeight, mode, model = 'lite', seed }: OpenPoseOptions): Promise<PoseStream> => {
      teardown()
      setStatus('loading')
      setError(null)

      const worker = new PoseWorker()
      workerRef.current = worker
      // Copied, not aliased: the caller keeps its own reference to whatever it
      // seeded us with, and must not see it change underneath.
      let frames: PoseFrame[] = seed ? seed.slice() : []
      /** The t of the frame in flight — the worker echoes it, but this is the ordering truth. */
      let pendingT = 0
      /**
       * Why startup failed, kept here rather than read back off `error` state.
       *
       * Reading the state would give whatever it held when this callback was
       * created, not what the worker just reported — so the throw below carried
       * a stale message, or null, exactly when a real reason existed.
       */
      let failure: string | null = null

      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data
        if (msg.type === 'ready') {
          setStatus('ready')
          readyWaiter.current?.(true)
          readyWaiter.current = null
        } else if (msg.type === 'pose') {
          if (msg.landmarks) {
            // Inserted in time order, replacing any reading of the same instant:
            // scrubbing back and forth over one moment should leave one frame,
            // not a pile of them.
            frames = insertFrame(frames, {
              t: msg.t,
              landmarks: msg.landmarks,
              world: msg.world ?? undefined,
            })
          }
          const waiter = frameWaiter.current
          frameWaiter.current = null
          waiter?.(msg.landmarks)
        } else if (msg.type === 'error') {
          failure = msg.message
          setError(msg.message)
          setStatus('error')
          // Unblock whatever was waiting, or the capture stalls on this frame.
          frameWaiter.current?.(null)
          frameWaiter.current = null
          readyWaiter.current?.(false)
          readyWaiter.current = null
        }
      }
      worker.onerror = (e: ErrorEvent) => {
        // A worker that fails to load reports a bare event with no message,
        // which is why there is a fallback rather than just e.message.
        failure = e.message || 'the pose worker failed to load'
        setError(failure)
        setStatus('error')
        readyWaiter.current?.(false)
        readyWaiter.current = null
      }

      const started = await new Promise<boolean>((resolve) => {
        readyWaiter.current = resolve
        worker.postMessage({ type: 'init', videoWidth, videoHeight, mode, model })
      })
      if (!started) throw new Error(failure ?? 'Pose estimation failed to start')

      return {
        get frames() {
          return frames
        },
        push: (frame: Frame) =>
          new Promise<void>((resolve) => {
            const live = workerRef.current
            if (!live) return resolve()
            pendingT = frame.t

            let settled = false
            const finish = () => {
              if (settled) return
              settled = true
              window.clearTimeout(timer)
              resolve()
            }
            // One frame must never strand the capture. The tracker takes the
            // same precaution for the same reason.
            const timer = window.setTimeout(() => {
              if (frameWaiter.current) {
                frameWaiter.current = null
                setError(`Pose estimation stalled at ${pendingT.toFixed(2)}s`)
              }
              finish()
            }, FRAME_TIMEOUT_MS)

            frameWaiter.current = () => finish()
            // Transferred, not copied — captureFrames already handed this a
            // private copy precisely so it could be given away here.
            live.postMessage(
              { type: 'frame', t: frame.t, width: frame.width, height: frame.height, data: frame.data.buffer },
              [frame.data.buffer],
            )
          }),
        // Scoped to THIS worker: closing a stream that has already been
        // superseded must not take its replacement down with it.
        close: () => teardown(worker),
      }
    },
    [teardown],
  )

  return { status, error, open }
}
