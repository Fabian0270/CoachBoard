import type { Frame, Sample } from './tracker.core'
import type { CaptureHandle, CaptureOptions } from './captureFrames'

// ---------------------------------------------------------------------------
// Every frame of the range, decoded rather than played (BP21).
//
// captureFrames reads frames off the playing <video>, which ties tracking to
// real time and, under load, loses about one frame in three. This decodes the
// file with WebCodecs (mediabunny) instead, at the tracker's own 320 px, as fast
// as the machine allows — measured on real phone clips at 9x real time for
// 640x480, ~3x for 1440x1440 and ~1x for 4K — and hands the tracker EVERY frame.
//
// Measured before relying on it: on three real phone clips (including a rotated
// 4K one) the decoder's frame times equal the element's mediaTime exactly, in
// the same orientation, so a seed placed on the paused video lands on the same
// frame here. Anything this cannot open (no decoder for the codec, an unreadable
// container) is reported as DecodeUnavailable BEFORE the first frame, so the
// page can fall back to playback.
// ---------------------------------------------------------------------------

/** The tracker's frame width, the same as captureFrames. */
const ANALYSIS_WIDTH = 320

/** Frames allowed to wait for the tracker before decoding waits too. */
const MAX_QUEUED = 4

export class DecodeUnavailable extends Error {
  constructor(why: string) {
    super(why)
    this.name = 'DecodeUnavailable'
  }
}

export async function decodeInto(
  source: string | Blob,
  /** The element showing the clip: its size is the coordinate space, and it is moved along as tracking goes. */
  video: HTMLVideoElement,
  push: (frame: Frame, isFirst: boolean) => Promise<Sample | null>,
  { from, to, onSample, signal, alsoPush }: CaptureOptions,
): Promise<CaptureHandle> {
  if (!video.videoWidth) throw new Error('Video has no decoded dimensions yet')
  const { ALL_FORMATS, BlobSource, CanvasSink, Input, UrlSource } = await import('mediabunny')

  const input = new Input({
    source: typeof source === 'string' ? new UrlSource(new URL(source, window.location.origin).toString()) : new BlobSource(source),
    formats: ALL_FORMATS,
  })
  try {
    let track
    try {
      track = await input.getPrimaryVideoTrack()
    } catch (err) {
      throw new DecodeUnavailable(err instanceof Error ? err.message : 'unreadable file')
    }
    if (!track) throw new DecodeUnavailable('no video track')
    if (!(await track.canDecode())) throw new DecodeUnavailable(`no decoder for ${track.codec ?? 'this codec'}`)
    // The element's size, so frames and seed share one space — the decoder's
    // display size was measured equal to it, rotation included.
    const scale = ANALYSIS_WIDTH / video.videoWidth
    const width = Math.round(video.videoWidth * scale)
    const height = Math.round(video.videoHeight * scale)

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not get a 2d context')

    const sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 2 })
    const span = Math.max(0.001, to - from)
    let framesRead = 0
    let alsoFrames = 0
    let stoppedEarly = false
    let lost = false
    let failed = false
    let inFlight: Promise<Sample | null> = Promise.resolve(null)
    let queued = 0
    let alsoInFlight: Promise<void> = Promise.resolve()
    let lastShown = 0

    for await (const wrapped of sink.canvases(from, to)) {
      if (signal?.aborted || lost || failed) {
        stoppedEarly = true
        break
      }
      ctx.drawImage(wrapped.canvas, 0, 0)
      const t = wrapped.timestamp
      const frame: Frame = { t, width, height, data: ctx.getImageData(0, 0, width, height).data }
      const isFirst = framesRead === 0
      framesRead++

      // Pose gets every frame too: nothing is lost by waiting here, where on
      // the playing video a frame not taken was gone. One at a time, and before
      // the tracker takes the buffer (its worker detaches it).
      if (alsoPush) {
        alsoFrames++
        const copy: Frame = { t, width, height, data: frame.data.slice() }
        await alsoInFlight
        alsoInFlight = alsoPush(copy).catch(() => {})
      }

      queued++
      inFlight = inFlight
        .then(() => push(frame, isFirst))
        .then((sample) => {
          queued--
          onSample?.(sample, Math.min(1, (t - from) / span))
          // null: the bar was lost, nothing further to follow.
          if (sample === null && !isFirst) lost = true
          return sample
        })
        .catch(() => {
          queued--
          failed = true
          return null
        })
      // Decoding outruns the tracker: wait rather than queue without bound.
      if (queued >= MAX_QUEUED) await inFlight

      // The video follows along a few times a second, so the coach sees where
      // the track has got to. Not every frame: a seek per frame would cost more
      // than the decoding.
      const now = performance.now()
      if (now - lastShown > 250) {
        lastShown = now
        video.currentTime = t
      }
    }
    await inFlight.catch(() => null)
    await alsoInFlight.catch(() => undefined)
    if (lost || failed) stoppedEarly = true
    if (framesRead === 0 && !signal?.aborted) throw new DecodeUnavailable('no frames in that range')
    video.currentTime = from
    return { scale, framesRead, stoppedEarly, alsoFrames }
  } finally {
    input.dispose()
  }
}
