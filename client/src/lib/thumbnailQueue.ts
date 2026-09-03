// ---------------------------------------------------------------------------
// Video poster-frame generation (Feature 11a).
//
// Thumbnails are produced here rather than on the server because Chromium has
// already had to decode the video to play it — a hidden <video> drawn onto a
// <canvas> costs nothing extra, whereas shipping ffmpeg to grab one frame would
// add ~80 MB per platform to the installer and to every auto-update.
//
// The whole module is ONE queue with a concurrency of one. That is the point of
// it: MediaTile's own comment explains that mounting many <video> elements
// exhausts the platform's decoder handles, so no matter how many tiles are on
// screen, exactly one video is ever alive for generation across the whole app.
// ---------------------------------------------------------------------------

/** How a generation attempt ended. 'ok' means the server now has a thumbnail. */
export type ThumbResult = 'ok' | 'unsupported' | 'failed'

export interface ThumbOutcome {
  result: ThumbResult
  /**
   * Measured during capture and handed back so the tile can show its duration
   * pill immediately. Without this the caller's props stay stale until whatever
   * fetched them refetches, and the pill pops in on a later visit instead.
   */
  durationMs: number | null
}

interface Job {
  mediaId: string
  resolve: (outcome: ThumbOutcome) => void
}

const THUMB_WIDTH = 256
const JPEG_QUALITY = 0.7
/** A single video that neither loads nor errors must not stall the whole queue. */
const JOB_TIMEOUT_MS = 20_000

const pending: Job[] = []
/** In-flight requests, so two tiles showing the same video share one attempt
 *  instead of the second caller waiting on a promise nobody resolves. */
const inflight = new Map<string, Promise<ThumbOutcome>>()
/** How many mounted tiles still want each id, so one unmounting doesn't cancel
 *  the work another is waiting on. */
const wanted = new Map<string, number>()
/**
 * Results for this session. A video that cannot be decoded on this machine will
 * never become decodable, so without this the tile would re-attempt on every
 * scroll past it — the exact loop that makes a list feel broken.
 */
const settled = new Map<string, ThumbOutcome>()
let running = false

/** Thrown when this machine has no decoder for the file (typically HEVC). */
class UnsupportedError extends Error {}

/** Chromium throttles frame production for fully hidden video, so the element is
 *  transparent and 1px rather than display:none — otherwise seeks silently never
 *  present a frame and every capture times out. */
function createHiddenVideo(mediaId: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.src = `/api/discord/media/${mediaId}/file`
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.style.cssText =
    'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(video)
  return video
}

function once(target: EventTarget, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    target.addEventListener(event, () => resolve(), { once: true, signal })
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

/**
 * Best-effort wait for the seeked frame to be composited, because `seeked` can
 * fire a beat before the frame is actually paintable.
 *
 * Deliberately a RACE against a short timer rather than a plain await:
 * requestVideoFrameCallback only fires when a frame is *presented*, and a paused
 * 1px-offscreen video often never presents one — awaiting it unconditionally
 * hangs every capture until the job timeout. The frame is already decoded by
 * `seeked`, so falling through and drawing anyway is correct; the wait is just
 * insurance against the race.
 */
function settleFrame(video: HTMLVideoElement): Promise<void> {
  const rvfc = (
    video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
    }
  ).requestVideoFrameCallback

  const presented = new Promise<void>((resolve) => {
    if (typeof rvfc === 'function') rvfc.call(video, () => resolve())
    else requestAnimationFrame(() => resolve())
  })
  const fallback = new Promise<void>((resolve) => setTimeout(resolve, 120))
  return Promise.race([presented, fallback])
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
}

async function reportStatus(mediaId: string, status: 'unsupported' | 'failed'): Promise<void> {
  await fetch(`/api/discord/media/${mediaId}/thumbnail/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }).catch(() => {})
}

async function generate(mediaId: string): Promise<ThumbOutcome> {
  const controller = new AbortController()
  const { signal } = controller
  const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS)
  const video = createHiddenVideo(mediaId)
  let durationMs: number | null = null

  try {
    // A codec this machine cannot decode surfaces either as an `error` event
    // (MEDIA_ERR_SRC_NOT_SUPPORTED) or as metadata with a zero-width frame.
    const failedToLoad = once(video, 'error', signal).then(() => {
      throw video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? new UnsupportedError()
        : new Error('load failed')
    })

    await Promise.race([once(video, 'loadedmetadata', signal), failedToLoad])
    if (!video.videoWidth || !video.videoHeight) throw new UnsupportedError()

    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration > 0) durationMs = Math.round(duration * 1000)
    // A quarter in, capped at one second: frame zero of a lifting clip is
    // usually a black or static pre-roll, which reads as a broken tile.
    const target = duration > 0 ? Math.min(1, duration * 0.25) : 0
    video.currentTime = target

    await Promise.race([once(video, 'seeked', signal), failedToLoad])
    await settleFrame(video)

    const scale = THUMB_WIDTH / video.videoWidth
    const canvas = document.createElement('canvas')
    canvas.width = THUMB_WIDTH
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const blob = await toBlob(canvas)
    if (!blob) throw new Error('encode failed')

    const query = new URLSearchParams({
      width: String(video.videoWidth),
      height: String(video.videoHeight),
      ...(durationMs != null ? { durationMs: String(durationMs) } : {}),
    })
    const res = await fetch(`/api/discord/media/${mediaId}/thumbnail?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    })
    if (!res.ok) throw new Error(`upload failed (${res.status})`)
    return { result: 'ok', durationMs }
  } catch (err) {
    const status = err instanceof UnsupportedError ? 'unsupported' : 'failed'
    // Surfaced because a thumbnail that silently never appears is exactly the
    // kind of thing that gets reported as "the app is broken" with no detail.
    console.warn(`[thumbnail] ${mediaId} ${status}:`, err)
    await reportStatus(mediaId, status)
    return { result: status, durationMs }
  } finally {
    clearTimeout(timer)
    controller.abort()
    // Detaching without clearing src leaves the decoder holding the file, which
    // on Windows also blocks the coach from ever deleting the video.
    video.removeAttribute('src')
    video.load()
    video.remove()
  }
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (pending.length > 0) {
      const job = pending.shift()!
      const outcome = await generate(job.mediaId)
      settled.set(job.mediaId, outcome)
      inflight.delete(job.mediaId)
      job.resolve(outcome)
    }
  } finally {
    running = false
  }
}

/**
 * Requests a thumbnail for one video. Safe to call from every tile that scrolls
 * into view: repeats, in-flight work and already-settled ids all collapse onto a
 * single attempt.
 */
export function requestThumbnail(mediaId: string): Promise<ThumbOutcome> {
  wanted.set(mediaId, (wanted.get(mediaId) ?? 0) + 1)

  const already = settled.get(mediaId)
  if (already) return Promise.resolve(already)

  const existing = inflight.get(mediaId)
  if (existing) return existing

  const promise = new Promise<ThumbOutcome>((resolve) => {
    pending.push({ mediaId, resolve })
  })
  inflight.set(mediaId, promise)
  void drain()
  return promise
}

/**
 * Releases one tile's interest in an id, dropping the job if it hasn't started
 * and nobody else still wants it. Without this, scrolling quickly through a few
 * hundred tiles leaves the queue generating thumbnails, one per second, for
 * videos the coach passed minutes ago.
 *
 * A job already being generated is left to finish — it holds the only decoder
 * handle in flight, and aborting mid-capture buys nothing.
 */
export function releaseThumbnail(mediaId: string): void {
  const remaining = (wanted.get(mediaId) ?? 1) - 1
  if (remaining > 0) {
    wanted.set(mediaId, remaining)
    return
  }
  wanted.delete(mediaId)

  const index = pending.findIndex((job) => job.mediaId === mediaId)
  if (index >= 0) {
    pending.splice(index, 1)
    inflight.delete(mediaId)
  }
}
