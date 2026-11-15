import {
  Conversion,
  Input,
  Output,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  WEBM,
  WebMOutputFormat,
  type StreamTargetChunk,
  type VideoSample,
} from 'mediabunny'
import { planEncoding } from './recorder.core'
import {
  bubbleCircle,
  clampPlacement,
  coverSquare,
  rimWidth,
  type Trim,
  type WebcamPlacement,
} from './recordingEdit'

// ---------------------------------------------------------------------------
// Building the edited video.
//
// The screen and the webcam are recorded as two files. This reads both, draws
// the webcam circle where the coach put it on every screen frame, keeps only the
// trimmed span, and writes one WebM — the same kind of file a recording always
// was, so saving, Discord and email need to know nothing about any of it.
//
// It runs at the speed of the machine, not the speed of the video: frames are
// decoded and encoded with WebCodecs (measured in this app at 4-6x real time for
// 1080p) rather than played back and re-recorded. Sound is copied, not
// re-encoded. Everything is local — the "URLs" are this app's own embedded
// server, the library is bundled — so it works with no network at all.
//
// Nothing is held whole in memory: the inputs are read in ranges straight from
// the server and the output is streamed back to it as it is produced. A long
// recording is well over 100 MB, and this page is the one compositing video.
// ---------------------------------------------------------------------------

export interface ExportOptions {
  recordingId: string
  /** The webcam, when one was recorded and is to be shown. Null leaves it out. */
  camera: { placement: WebcamPlacement; offsetMs: number } | null
  /** The span to keep, or null for the whole recording. */
  trim: Trim | null
  /** 0..1 as the export proceeds. */
  onProgress?(fraction: number): void
  /** Aborting cancels the export and removes the partial result. */
  signal?: AbortSignal
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}

/** Output is handed to the server in pieces about this big. */
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

const api = (id: string, rest: string): string =>
  new URL(`/api/recorder/recordings/${encodeURIComponent(id)}${rest}`, window.location.origin).toString()

async function post(url: string, body?: BodyInit, contentType?: string): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: contentType ? { 'Content-Type': contentType } : undefined,
    body,
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(detail.error ?? `The server refused the export (${res.status}).`)
  }
  return res
}

/**
 * Reads webcam frames in step with the screen frames.
 *
 * The export walks the screen video forwards, so the webcam is walked forwards
 * alongside it: `at(t)` returns the latest webcam frame at or before `t`,
 * decoding each frame once.
 */
function cameraReader(sink: VideoSampleSink, startAt: number) {
  const frames = sink.samples(Math.max(0, startAt))
  let current: VideoSample | null = null
  let upcoming: VideoSample | null = null
  let primed = false
  let finished = false

  const pull = async (): Promise<VideoSample | null> => {
    if (finished) return null
    const next = await frames.next()
    if (next.done) {
      finished = true
      return null
    }
    return next.value
  }

  return {
    async at(time: number): Promise<VideoSample | null> {
      if (!primed) {
        primed = true
        upcoming = await pull()
      }
      while (upcoming && upcoming.timestamp <= time) {
        current?.close()
        current = upcoming
        upcoming = await pull()
      }
      // Before the webcam's first frame (it starts a moment after the screen):
      // show that first frame rather than a hole.
      return current ?? upcoming
    },
    async close(): Promise<void> {
      current?.close()
      upcoming?.close()
      current = null
      upcoming = null
      finished = true
      await frames.return?.(undefined)
    },
  }
}

/**
 * Builds the edited video and stores it as the recording's `final` track.
 * Resolves with its size in bytes.
 */
export async function exportRecording(opts: ExportOptions): Promise<{ bytes: number }> {
  const { recordingId: id, camera, trim, onProgress, signal } = opts
  if (signal?.aborted) throw new ExportCancelled()

  await post(api(id, '/begin?track=final'))

  const screenInput = new Input({ source: new UrlSource(api(id, '/file?track=screen')), formats: [WEBM] })
  const cameraInput = camera
    ? new Input({ source: new UrlSource(api(id, '/file?track=camera')), formats: [WEBM] })
    : null
  let reader: ReturnType<typeof cameraReader> | null = null

  try {
    const screenTrack = await screenInput.getPrimaryVideoTrack()
    if (!screenTrack) throw new Error('The recording has no video to export.')
    const width = screenTrack.displayWidth
    const height = screenTrack.displayHeight

    // Writes are sequential per request but positioned: a WebM writer goes back
    // to fill in sizes, the duration and the seek index at the end.
    const writable = new WritableStream<StreamTargetChunk>({
      async write(chunk) {
        await post(api(id, `/chunk?track=final&position=${chunk.position}`), chunk.data, 'video/webm')
      },
    })
    const output = new Output({
      format: new WebMOutputFormat(),
      target: new StreamTarget(writable, { chunked: true, chunkSize: UPLOAD_CHUNK_BYTES }),
    })

    let process: ((sample: VideoSample) => Promise<OffscreenCanvas>) | undefined
    if (camera && cameraInput) {
      const cameraTrack = await cameraInput.getPrimaryVideoTrack()
      if (!cameraTrack) throw new Error('The webcam recording could not be read.')
      const placement = clampPlacement(camera.placement, width, height)
      const { cx, cy, radius } = bubbleCircle(placement, width, height)
      const rim = rimWidth(width, height)
      const offset = camera.offsetMs / 1000
      const trimStart = trim?.start ?? 0
      reader = cameraReader(new VideoSampleSink(cameraTrack), trimStart - offset)
      const activeReader = reader

      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('Could not prepare the export canvas.')

      process = async (sample) => {
        sample.draw(ctx, 0, 0, width, height)
        // The sample's time is on the OUTPUT timeline (shifted by the trim);
        // the webcam file is on the original one, started `offset` later.
        const face = await activeReader.at(sample.timestamp + trimStart - offset)
        if (face) {
          const crop = coverSquare(face.displayWidth, face.displayHeight)
          ctx.save()
          ctx.beginPath()
          ctx.arc(cx, cy, radius, 0, Math.PI * 2)
          ctx.clip()
          face.draw(ctx, crop.sx, crop.sy, crop.size, crop.size, cx - radius, cy - radius, radius * 2, radius * 2)
          ctx.restore()
          // A rim, because a circular crop of a dim room against a dark
          // screenshot otherwise has no edge at all and reads as a smudge.
          ctx.beginPath()
          ctx.arc(cx, cy, radius, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
          ctx.lineWidth = rim
          ctx.stroke()
        }
        return canvas
      }
    }

    const conversion = await Conversion.init({
      input: screenInput,
      output,
      trim: trim ? { start: trim.start, end: trim.end } : undefined,
      video: {
        // VP9: what recordings already use, and far smaller than VP8 at the
        // same quality — which matters against Discord's size cap.
        codec: 'vp9',
        bitrate: planEncoding(width, height).videoBitsPerSecond,
        ...(process ? { process, processedWidth: width, processedHeight: height } : {}),
      },
      showWarnings: false,
    })
    // isValid is true as long as ANY track survives, so a file with sound but
    // no picture would pass it. The picture is the point; insist on it.
    const lostVideo = conversion.discardedTracks.find((t) => t.track.type === 'video')
    if (!conversion.isValid || lostVideo) {
      const why = conversion.discardedTracks.map((t) => `${t.track.type}: ${t.reason}`).join(', ')
      throw new Error(`This recording cannot be exported on this computer (${why || 'unsupported video'}).`)
    }

    conversion.onProgress = (fraction) => onProgress?.(Math.min(1, Math.max(0, fraction)))
    const onAbort = (): void => {
      void conversion.cancel()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await conversion.execute()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (signal?.aborted) throw new ExportCancelled()

    const sealed = (await (await post(api(id, '/finish?track=final'))).json()) as { bytes: number }
    onProgress?.(1)
    return { bytes: sealed.bytes }
  } catch (err) {
    // Leave no half-written edit behind: saving and sending would otherwise
    // fall back to it, or to nothing.
    await fetch(api(id, '/final'), { method: 'DELETE' }).catch(() => {})
    if (signal?.aborted) throw new ExportCancelled()
    throw err
  } finally {
    await reader?.close().catch(() => {})
    screenInput.dispose()
    cameraInput?.dispose()
  }
}

/** Drops a previous edit, so the plain screen recording is what gets saved or sent. */
export async function discardExport(recordingId: string): Promise<{ bytes: number }> {
  const res = await fetch(api(recordingId, '/final'), { method: 'DELETE' })
  if (!res.ok) throw new Error('Could not reset the recording.')
  return (await res.json()) as { bytes: number }
}
