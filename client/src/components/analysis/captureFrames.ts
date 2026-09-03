import type { Frame } from './tracker.core'

// ---------------------------------------------------------------------------
// Pulls decoded frames out of a <video> for tracking.
//
// Frames are collected during real muted playback via requestVideoFrameCallback,
// not by seeking. rVFC hands back each frame's exact mediaTime, which is the
// only honest way to timestamp variable-frame-rate phone video — deriving
// positions from an assumed fps would silently skew every velocity later.
//
// Seeking frame by frame would be exact but costs 30-150 ms per seek on a
// keyframe-sparse H.264 stream, i.e. minutes for a few hundred frames. Playback
// costs exactly the clip's own duration.
// ---------------------------------------------------------------------------

/** Downscale target. Tracking does not need full resolution, and a few hundred
 *  full-size RGBA frames is hundreds of megabytes. */
const ANALYSIS_WIDTH = 320

export interface CaptureResult {
  frames: Frame[]
  /** frame pixels -> original video pixels, for mapping results back. */
  scale: number
}

export interface CaptureOptions {
  from: number
  to: number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export async function captureFrames(
  video: HTMLVideoElement,
  { from, to, signal, onProgress }: CaptureOptions,
): Promise<CaptureResult> {
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
    video.addEventListener('seeked', () => resolve(), { once: true })
  })

  const frames: Frame[] = []
  const span = Math.max(0.001, to - from)

  await new Promise<void>((resolve) => {
    const stop = () => {
      video.pause()
      resolve()
    }
    if (signal?.aborted) return stop()
    signal?.addEventListener('abort', stop, { once: true })

    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (signal?.aborted || meta.mediaTime > to || video.ended) return stop()
      ctx.drawImage(video, 0, 0, width, height)
      frames.push({
        t: meta.mediaTime,
        width,
        height,
        data: ctx.getImageData(0, 0, width, height).data,
      })
      onProgress?.(Math.min(1, (meta.mediaTime - from) / span))
      video.requestVideoFrameCallback(onFrame)
    }

    video.requestVideoFrameCallback(onFrame)
    void video.play()
  })

  video.muted = wasMuted
  video.currentTime = wasTime
  return { frames, scale }
}
