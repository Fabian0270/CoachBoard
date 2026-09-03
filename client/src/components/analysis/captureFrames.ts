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

/**
 * Playback speed while capturing. Half speed is not a nicety — it is what makes
 * the numbers trustworthy.
 *
 * Pulling a frame off a playing <video> costs ~34 ms here however it is done:
 * measured at 33.9 ms via createImageBitmap, 35.1 ms via a CPU-backed canvas at
 * 160px wide, 39.8 ms via a GPU canvas at 320px. It is a fixed GPU sync per
 * readback, not pixel work — dropping the resolution changes nothing. At normal
 * speed that exceeds the 33 ms frame budget, so every other frame is missed and
 * a 30 fps clip yields 15 samples per second.
 *
 * That matters because velocity is a local quadratic fit over a ±75 ms window:
 * at 15 fps that window holds barely the three points the fit needs, so the
 * velocity gets noticeably worse. Measured samples per video-second: 15.2 at
 * 1.0x, 18.9 at 0.75x, 29.6 at 0.5x, 30.1 at 0.35x. Half speed is where every
 * frame lands, and going slower only costs more waiting.
 */
const CAPTURE_PLAYBACK_RATE = 0.5

export interface CaptureOptions {
  from: number
  to: number
  /** Receives each tracked position as it is produced, for live drawing. */
  onSample?: (sample: Sample | null, fraction: number) => void
  signal?: AbortSignal
}

export interface CaptureHandle {
  /** frame pixels -> original video pixels, for mapping results back. */
  scale: number
  framesRead: number
  /** True when capture ended early — aborted, stalled, or the bar was lost. */
  stoppedEarly: boolean
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
  { from, to, onSample, signal }: CaptureOptions,
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
  const wasRate = video.playbackRate
  video.muted = true
  video.playbackRate = CAPTURE_PLAYBACK_RATE
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

      ctx.drawImage(video, 0, 0, width, height)
      const frame: Frame = {
        t: meta.mediaTime,
        width,
        height,
        data: ctx.getImageData(0, 0, width, height).data,
      }
      const isFirst = framesRead === 0
      framesRead++

      // Tracking runs in the worker while playback continues here, so capture
      // is not gated on it. The chain keeps frames in order without buffering.
      inFlight = inFlight
        .then(() => push(frame, isFirst))
        .then((sample) => {
          onSample?.(sample, Math.min(1, (meta.mediaTime - from) / span))
          // null means the bar was lost — there is nothing further to follow.
          if (sample === null && !isFirst) stop(true)
          return sample
        })
        .catch(() => {
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

  video.muted = wasMuted
  video.playbackRate = wasRate
  video.currentTime = wasTime
  return { scale, framesRead, stoppedEarly }
}
