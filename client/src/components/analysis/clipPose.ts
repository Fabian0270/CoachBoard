import type { PoseFrame } from 'coachboard-shared/pose'
import type { Frame } from './tracker.core'
import type { PoseStream } from './usePose'

// ---------------------------------------------------------------------------
// The skeleton, read from the whole clip before it is shown (D117).
//
// It used to be read live: the frame on screen while scrubbing, and the frames
// the tracker pulled while it followed the bar, with the model carrying its
// search region from one frame to the next. Filmed from the side, a loaded bar
// hides the legs, and that carried region drifted onto the plate and stayed
// there — the knee read 22-39 degrees at the start of a deadlift and sat on the
// plate at lockout. Read frame by frame on its own (IMAGE mode), the model finds
// the legs whenever they are clear, and the clip as a whole says where the feet
// are planted and how long the bones are (poseRefine.ts), which puts the hidden
// ones right. That needs every frame first, so the coach waits a little and
// then sees the best limbs the clip allows (Fabian, 2026-11-20).
//
// Measured in the packaged app: decoding every frame of a 12 s clip takes
// 0.5 s; the model is the cost, about 60 ms a frame. 15 frames a second is
// plenty for a lift and keeps a 12 s clip to roughly 15 s.
// ---------------------------------------------------------------------------

/** Frames read per second of video. */
export const POSE_READ_FPS = 15

/**
 * The width frames are read at.
 *
 * 512, and the number was measured (for the live preview this replaces).
 * MediaPipe detects the person and then runs the landmark model on a CROP of
 * them, so a lifter who is a quarter of the frame becomes a tiny, upsampled
 * crop when the frame is small: on a real squat clip, mean lower-body
 * visibility went 0.83 at 256 to 0.88 at 384-512, while inference time was flat
 * at 70-80 ms from 256 to 1080. Past ~512 it stops improving.
 */
export const POSE_READ_WIDTH = 512

/** One decoded frame on its way to the model. */
export interface DecodedFrame {
  /** Seconds on the clip's own clock — the one the player and the bar path use. */
  t: number
  /** Drawn at POSE_READ_WIDTH, the right way up. */
  canvas: HTMLCanvasElement | OffscreenCanvas
}

export interface ReadOptions {
  stream: PoseStream
  /** Clip length in seconds, for the progress. */
  duration: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** While this says so, reading waits (tracking is running and needs the CPU). */
  hold?: () => boolean
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Feeds every frame `POSE_READ_FPS` apart to the model and returns what it
 * found, in time order. Stops early, with what it has, when `signal` aborts.
 */
export async function readFrames(frames: AsyncIterable<DecodedFrame>, opts: ReadOptions): Promise<PoseFrame[]> {
  const gap = 1 / POSE_READ_FPS
  let next = -Infinity
  for await (const f of frames) {
    if (opts.signal?.aborted) break
    // A hair of slack so 30 fps footage gives exactly every other frame.
    if (f.t < next - gap * 0.25) continue
    next = f.t + gap
    while (opts.hold?.() && !opts.signal?.aborted) await wait(200)
    if (opts.signal?.aborted) break
    const ctx = f.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) continue
    const { width, height } = f.canvas
    const frame: Frame = { t: f.t, width, height, data: ctx.getImageData(0, 0, width, height).data }
    await opts.stream.push(frame)
    if (opts.duration > 0) opts.onProgress?.(Math.min(1, f.t / opts.duration))
  }
  return opts.stream.frames
}

/** Which frames, and how wide. Defaults: the whole clip at POSE_READ_WIDTH. */
export interface DecodeRange {
  width?: number
  from?: number
  to?: number
}

/** Every frame of a clip, decoded off screen with mediabunny. Throws when it cannot read the file. */
export async function* decodeWithMediabunny(source: { blob: Blob } | { url: string }, range: DecodeRange = {}): AsyncGenerator<DecodedFrame> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input, UrlSource } = await import('mediabunny')
  const input = new Input({
    formats: ALL_FORMATS,
    source: 'blob' in source ? new BlobSource(source.blob) : new UrlSource(source.url),
  })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('This clip cannot be decoded here')
    // Turned the right way up from the clip's rotation metadata, as the player shows it.
    const sink = new CanvasSink(track, { width: range.width ?? POSE_READ_WIDTH, poolSize: 2 })
    for await (const wrapped of sink.canvases(range.from, range.to)) {
      yield { t: wrapped.timestamp, canvas: wrapped.canvas }
    }
  } finally {
    input.dispose()
  }
}

/**
 * Every frame POSE_READ_FPS apart, by seeking a video element. Slower, but it
 * reads whatever the player can play — the fallback when mediabunny cannot.
 */
export async function* decodeBySeeking(src: string, duration: number, range: DecodeRange & { fps?: number } = {}): AsyncGenerator<DecodedFrame> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = src
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('This clip cannot be played'))
  })
  const width = range.width ?? POSE_READ_WIDTH
  const height = Math.round((width / video.videoWidth) * video.videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  try {
    const end = Math.min(range.to ?? Infinity, duration || video.duration)
    for (let t = range.from ?? 0; t < end; t += 1 / (range.fps ?? POSE_READ_FPS)) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve()
        video.currentTime = t
      })
      // Drawn from the element, which applies the rotation; see the preview's note.
      ctx.drawImage(video, 0, 0, width, height)
      yield { t: video.currentTime, canvas }
    }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

export interface ClipPoseOptions extends Omit<ReadOptions, 'stream'> {
  /** The file itself for a local clip, its URL for one the app serves. */
  source: { blob: Blob } | { url: string }
  /** What the player plays — for the fallback. */
  src: string
  open: () => Promise<PoseStream>
}

/** Reads the whole clip's skeleton: mediabunny first, seeking the player if that cannot read it. */
export async function readClipPose(opts: ClipPoseOptions): Promise<PoseFrame[]> {
  const stream = await opts.open()
  try {
    try {
      return await readFrames(decodeWithMediabunny(opts.source), { ...opts, stream })
    } catch (err) {
      if (opts.signal?.aborted) throw err
      // Nothing read yet means the decoder refused the file; part-way is a real failure.
      if (stream.frames.length > 0) throw err
      return await readFrames(decodeBySeeking(opts.src, opts.duration), { ...opts, stream })
    }
  } finally {
    stream.close()
  }
}
