import type { Frame, Sample } from './tracker.core'

// ---------------------------------------------------------------------------
// Pulls decoded frames out of a <video> and feeds them straight to the tracker.
//
// Frames are collected during real muted playback via requestVideoFrameCallback,
// not by seeking. rVFC hands back each frame's exact mediaTime, which is the
// only honest way to timestamp variable-frame-rate phone video — deriving
// positions from an assumed fps would silently skew every velocity later.
// Seeking frame by frame would be exact but costs 30-150 ms per seek on a
// keyframe-sparse H.264 stream, i.e. minutes for a few hundred frames.
//
// Nothing is buffered. An earlier version collected every frame into an array
// and tracked afterwards, which held ~330 MB for a twenty-second clip and could
// not draw anything until the whole clip had been read. Optical flow only ever
// compares a frame to its predecessor, so frames are handed over as they
// decode and released immediately.
//
// The canvas readback below looks expensive in isolation and is not: measured
// end to end it captures ~30 samples per video-second at normal playback speed.
// Two "faster" alternatives were tried and both were worse. Playing at half
// speed caught every frame but ran the clip in slow motion for no real gain.
// Handing ImageBitmaps to the worker tracked almost nothing, because
// createImageBitmap applies its resize BEFORE the video's rotation metadata —
// a 480x640 portrait clip came back as a 427x320 bitmap holding sideways
// content, and the bar path collapsed to a 17px wiggle. Drawing the video
// element directly is what keeps the frame in the orientation the coach sees.
// ---------------------------------------------------------------------------

/** Downscale target. Tracking does not need full resolution. */
const ANALYSIS_WIDTH = 320

/**
 * If no new frame arrives for this long the capture stops on its own.
 *
 * Without it, anything that quietly halts playback — a blocked play(), a video
 * element that stops presenting frames — left the UI on "Reading frames…"
 * forever with no error and no way back. A stall is not worth hanging over.
 */
const STALL_TIMEOUT_MS = 5_000

export interface CaptureOptions {
  from: number
  to: number
  /** Receives each tracked position as it is produced, for live drawing. */
  onSample?: (sample: Sample | null, fraction: number) => void
  signal?: AbortSignal
  /**
   * A SECOND consumer of the same decoded frames — pose estimation (11e).
   *
   * Reading frames costs a whole clip's playback time before a millisecond of
   * anything else, so the one thing that must not happen is reading them twice.
   * This is the fan-out: the coach waits exactly as long as tracking already
   * takes, and gets a skeleton for it.
   *
   * It gets its own COPY of the pixels. The tracker's worker takes ownership of
   * the frame buffer by transferring it, which detaches the array — handing the
   * same one to two consumers would leave the second reading zero bytes.
   *
   * Frames are DROPPED while it is still working on the previous one rather than
   * queued. Pose was measured at ~32 ms against a ~33 ms frame interval, so it
   * roughly keeps up, and "roughly" is the whole problem: a queue that grows a
   * frame every so often is the ~330 MB mistake 11a already made. A skeleton
   * that skips a frame here and there is not worth memory that grows without a
   * bound.
   */
  alsoPush?: (frame: Frame) => Promise<void>
}

export interface CaptureHandle {
  /** frame pixels -> original video pixels, for mapping results back. */
  scale: number
  framesRead: number
  /** True when capture ended early — aborted, stalled, or the bar was lost. */
  stoppedEarly: boolean
  /** How many frames `alsoPush` actually saw. Lower than framesRead when it fell behind. */
  alsoFrames: number
}

/**
 * Plays `video` from `from` to `to`, handing every decoded frame to `push`.
 *
 * `push` returns the tracked position for that frame, or null once the bar has
 * been lost — at which point there is nothing left to follow and capture stops.
 */
export async function captureInto(
  video: HTMLVideoElement,
  push: (frame: Frame, isFirst: boolean) => Promise<Sample | null>,
  { from, to, onSample, signal, alsoPush }: CaptureOptions,
): Promise<CaptureHandle> {
  if (!video.videoWidth) throw new Error('Video has no decoded dimensions yet')

  const scale = ANALYSIS_WIDTH / video.videoWidth
  const width = Math.round(video.videoWidth * scale)
  const height = Math.round(video.videoHeight * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not get a 2d context')

  const wasMuted = video.muted
  const wasTime = video.currentTime
  video.muted = true
  video.currentTime = from
  await new Promise<void>((resolve) => {
    const done = () => resolve()
    video.addEventListener('seeked', done, { once: true })
    // A seek that never completes must not strand the whole analysis.
    setTimeout(done, 3000)
  })

  const span = Math.max(0.001, to - from)
  let framesRead = 0
  let stoppedEarly = false
  let inFlight: Promise<Sample | null> = Promise.resolve(null)
  /** The second consumer's own chain — see alsoPush. Never queues more than one. */
  let alsoBusy = false
  let alsoInFlight: Promise<void> = Promise.resolve()
  let alsoFrames = 0
  /** Whether the tracker still has a frame out. Pose only gets the gaps. */
  let trackerBusy = false

  await new Promise<void>((resolve) => {
    let stallTimer: number | undefined
    let finished = false

    const stop = (early: boolean) => {
      if (finished) return
      finished = true
      if (early) stoppedEarly = true
      window.clearTimeout(stallTimer)
      video.pause()
      resolve()
    }

    const armStall = () => {
      window.clearTimeout(stallTimer)
      stallTimer = window.setTimeout(() => stop(true), STALL_TIMEOUT_MS)
    }

    if (signal?.aborted) return stop(true)
    signal?.addEventListener('abort', () => stop(true), { once: true })
    video.addEventListener('ended', () => stop(false), { once: true })

    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (finished) return
      if (meta.mediaTime > to) return stop(false)
      armStall()

      // Drawing the video element directly is what keeps the frame in the same
      // orientation the coach clicked on — the element applies the clip's
      // rotation metadata, and anything that bypasses it does not.
      ctx.drawImage(video, 0, 0, width, height)
      const frame: Frame = {
        t: meta.mediaTime,
        width,
        height,
        data: ctx.getImageData(0, 0, width, height).data,
      }
      const isFirst = framesRead === 0
      framesRead++

      // Fanned out BEFORE the tracker gets the frame: push() transfers the
      // buffer to its worker, which detaches it, so the copy has to be taken
      // while the pixels are still readable.
      //
      // ONLY WHEN THE TRACKER IS IDLE. Two WASM runtimes on one machine do
      // compete, and feeding pose on every frame regardless made the bar path
      // measurably worse — laggier, and a worse path, because the tracker's
      // effective frame rate is exactly what its accuracy rests on. The path is
      // the measurement and the skeleton is commentary on it, so the skeleton
      // gets the gaps and never the frames the tracker wanted. On a clip where
      // the tracker keeps up easily that is most of them; where it does not,
      // pose quietly thins out instead of degrading the thing being measured.
      if (alsoPush && !alsoBusy && !trackerBusy) {
        alsoBusy = true
        alsoFrames++
        const copy: Frame = { t: frame.t, width, height, data: frame.data.slice() }
        alsoInFlight = alsoInFlight
          .then(() => alsoPush(copy))
          // A pose failure must not take the bar path down with it.
          .catch(() => {})
          .finally(() => {
            alsoBusy = false
          })
      }

      // Tracking runs in the worker while playback continues here, so capture
      // is not gated on it. The chain keeps frames in order without buffering.
      trackerBusy = true
      inFlight = inFlight
        .then(() => push(frame, isFirst))
        .then((sample) => {
          trackerBusy = false
          onSample?.(sample, Math.min(1, (meta.mediaTime - from) / span))
          // null means the bar was lost — there is nothing further to follow.
          if (sample === null && !isFirst) stop(true)
          return sample
        })
        .catch(() => {
          // Cleared here too, or a single failed frame would leave the flag set
          // and starve pose for the rest of the run.
          trackerBusy = false
          stop(true)
          return null
        })

      video.requestVideoFrameCallback(onFrame)
    }

    armStall()
    video.requestVideoFrameCallback(onFrame)
    void video.play().catch(() => stop(true))
  })

  await inFlight.catch(() => null)
  await alsoInFlight.catch(() => undefined)

  video.muted = wasMuted
  video.currentTime = wasTime
  return { scale, framesRead, stoppedEarly, alsoFrames }
}
