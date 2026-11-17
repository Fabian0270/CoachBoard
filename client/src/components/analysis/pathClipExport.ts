import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  UrlSource,
  WebMOutputFormat,
  type VideoSample,
} from 'mediabunny'
import { planEncoding } from '../recorder/recorder.core'
import type { Stroke } from './annotations'
import { paintDot, paintPath, paintStrokes, sampleAt } from './pathPaint'

// ---------------------------------------------------------------------------
// A clip with the bar path drawn in (BP25): the natural thing to post back to
// the athlete.
//
// Built the way the recorder builds its edited video — decoded and encoded
// with WebCodecs through mediabunny, faster than real time, nothing leaving
// the machine — and painted with the stage's own painter, so the file shows
// what the coach saw: the path, the rep under the playhead picked out, the dot
// and the pen marks. Sized by the recorder's plan (720p-class, the bitrate the
// Discord limit was worked out against), and only the tracked stretch with a
// little either side, which is what keeps it small enough to send.
// ---------------------------------------------------------------------------

export interface PathClipOptions {
  /** This app's URL for the clip, or the coach's own file. */
  source: string | Blob
  /** In the clip's display pixels, as tracked. */
  track: { t: number; x: number; y: number }[]
  reps: { startT: number; endT: number }[]
  strokes: Stroke[]
  color: string
  onProgress?(fraction: number): void
  signal?: AbortSignal
}

export class PathClipCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'PathClipCancelled'
  }
}

/** Kept either side of the tracked stretch, so the lift does not start and stop mid-movement. */
const PAD_S = 0.5

export async function exportPathClip(opts: PathClipOptions): Promise<Blob> {
  const { source, track, reps, strokes, color, onProgress, signal } = opts
  if (track.length < 2) throw new Error('There is no tracked path to draw.')
  if (signal?.aborted) throw new PathClipCancelled()

  const input = new Input({
    source: typeof source === 'string' ? new UrlSource(new URL(source, window.location.origin).toString()) : new BlobSource(source),
    formats: ALL_FORMATS,
  })
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) throw new Error('The clip has no video to draw on.')
    // Display size: after rotation, the same space the path was tracked in.
    const srcWidth = videoTrack.displayWidth
    const srcHeight = videoTrack.displayHeight
    const { width, height, videoBitsPerSecond } = planEncoding(srcWidth, srcHeight)
    const scale = width / srcWidth
    // The stage's lines are sized for a screen; a 720p frame needs them a bit heavier.
    const k = Math.max(1, Math.min(2.5, Math.max(width, height) / 800))

    const duration = await input.computeDuration()
    const start = Math.max(0, track[0].t - PAD_S)
    const end = Math.min(duration, track[track.length - 1].t + PAD_S)

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not prepare the drawing canvas.')

    const target = new BufferTarget()
    const output = new Output({ format: new WebMOutputFormat(), target })
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start, end },
      video: {
        codec: 'vp9',
        bitrate: videoBitsPerSecond,
        width,
        height,
        fit: 'fill',
        // Rotation baked into the frames, so they are in the path's orientation.
        allowTransformationMetadata: false,
        process: (sample: VideoSample) => {
          sample.draw(ctx, 0, 0, width, height)
          // The sample's time is on the output timeline, which starts at the trim.
          const t = sample.timestamp + start
          paintStrokes(ctx, strokes, scale, k)
          paintPath(ctx, { path: track, reps, playhead: t, color, scale, k })
          const at = sampleAt(track, t)
          if (at) paintDot(ctx, at, color, scale, k)
          return canvas
        },
        processedWidth: width,
        processedHeight: height,
      },
      showWarnings: false,
    })
    // isValid holds as long as ANY track survives; the picture is the point.
    const lostVideo = conversion.discardedTracks.find((d) => d.track.type === 'video')
    if (!conversion.isValid || lostVideo) {
      const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ')
      throw new Error(`This clip cannot be re-encoded on this computer (${why || 'unsupported video'}).`)
    }
    conversion.onProgress = (fraction) => onProgress?.(Math.min(1, Math.max(0, fraction)))
    const onAbort = () => void conversion.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await conversion.execute()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (signal?.aborted) throw new PathClipCancelled()
    if (!target.buffer) throw new Error('The clip came out empty.')
    onProgress?.(1)
    return new Blob([target.buffer], { type: 'video/webm' })
  } catch (err) {
    if (signal?.aborted) throw new PathClipCancelled()
    throw err
  } finally {
    input.dispose()
  }
}
