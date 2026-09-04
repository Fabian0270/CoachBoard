// ---------------------------------------------------------------------------
// The parts of the recorder that are decisions rather than plumbing: what to
// encode at, how big the result will be, and where it can still be delivered.
//
// Deliberately free of DOM, MediaRecorder and fetch — the same split as
// tracker.core.ts against tracker.worker.ts, and for the same reason. This repo
// has no jsdom and no testing-library, so anything that touches a browser API
// is verified by hand. Keeping the arithmetic here means the numbers that
// decide whether a coach can send their recording are actually tested.
// ---------------------------------------------------------------------------

/**
 * A Discord bot may attach 10 MiB. Not 25 — that is the Nitro-user limit, and
 * the bot is neither. This is the binding constraint on the whole feature.
 */
export const DISCORD_MAX_BYTES = 10 * 1024 * 1024

/**
 * Mail providers advertise 25 MB, but base64 inflates an attachment by ~33% on
 * the wire, so a 25 MB file is not a 25 MB message. 20 MB is the largest file
 * that reliably survives that inflation under a 25 MB ceiling.
 */
export const EMAIL_MAX_BYTES = 20 * 1024 * 1024

/** Warn at 80% rather than at the cliff — the coach is still talking. */
const NEAR_LIMIT_FRACTION = 0.8

export type DeliveryChannel = 'discord' | 'email' | 'disk'

export type SizeStatus = 'ok' | 'near' | 'over'

export interface EncodingPlan {
  width: number
  height: number
  frameRate: number
  videoBitsPerSecond: number
  audioBitsPerSecond: number
}

/**
 * Cap on the long edge. A 4K monitor captured 1:1 produces a file no delivery
 * path can take and a compositor that cannot hold 30fps, and the detail is
 * wasted: what the athlete needs to read is a bar path and a table of numbers,
 * both of which survive 720p comfortably.
 */
const MAX_LONG_EDGE = 1280

/** 1.5 Mbps at 1280x720, scaled by pixel count and clamped at both ends. */
const REFERENCE_PIXELS = 1280 * 720
const REFERENCE_VIDEO_BPS = 1_500_000
const MIN_VIDEO_BPS = 600_000
const MAX_VIDEO_BPS = 2_500_000

/** Speech, not music. Opus is transparent for a voice-over well below this. */
export const AUDIO_BITS_PER_SECOND = 96_000

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Encoders reject or silently pad odd dimensions, so both are forced even. */
const toEven = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/**
 * Chooses the output size and bitrate for a captured source.
 *
 * Only ever scales down. Capturing a small window and upscaling it to 720p
 * would spend bitrate inventing pixels that were never in the source.
 */
export function planEncoding(sourceWidth: number, sourceHeight: number): EncodingPlan {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    // A source that reports no dimensions yet still has to produce a usable
    // plan — the compositor needs a canvas size before the first frame lands.
    return {
      width: 1280,
      height: 720,
      frameRate: 30,
      videoBitsPerSecond: REFERENCE_VIDEO_BPS,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    }
  }

  const longEdge = Math.max(sourceWidth, sourceHeight)
  const scale = Math.min(1, MAX_LONG_EDGE / longEdge)
  const width = toEven(sourceWidth * scale)
  const height = toEven(sourceHeight * scale)

  const videoBitsPerSecond = Math.round(
    clamp((REFERENCE_VIDEO_BPS * (width * height)) / REFERENCE_PIXELS, MIN_VIDEO_BPS, MAX_VIDEO_BPS),
  )

  return {
    width,
    height,
    frameRate: 30,
    videoBitsPerSecond,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  }
}

/**
 * Predicted size of a recording of `ms` at this plan.
 *
 * Used before a single byte exists, to tell the coach up front roughly how long
 * they can talk and still DM it. The real figure comes from the bytes actually
 * produced — see `sizeStatus` — because VP9 is variable-bitrate and a static
 * program page compresses far better than a moving lift.
 */
export function estimateBytes(ms: number, plan: EncodingPlan): number {
  if (!(ms > 0)) return 0
  const bitsPerSecond = plan.videoBitsPerSecond + plan.audioBitsPerSecond
  return Math.round((bitsPerSecond * ms) / 8000)
}

/** How long the coach can talk before `limitBytes` is reached, in ms. */
export function budgetMs(limitBytes: number, plan: EncodingPlan): number {
  const bitsPerSecond = plan.videoBitsPerSecond + plan.audioBitsPerSecond
  if (!(bitsPerSecond > 0)) return 0
  return Math.max(0, Math.round((limitBytes * 8000) / bitsPerSecond))
}

/**
 * Which channels can still take a recording of this size.
 *
 * Disk is always true and is the reason the recorder can never dead-end: there
 * is no size at which the coach is left with nothing to do with their work.
 */
export function deliveryFitness(bytes: number): Record<DeliveryChannel, boolean> {
  return {
    discord: bytes <= DISCORD_MAX_BYTES,
    email: bytes <= EMAIL_MAX_BYTES,
    disk: true,
  }
}

/**
 * Traffic light for the live size meter, measured against Discord because it is
 * the tightest cap and the one the coach is most likely to be aiming for.
 */
export function sizeStatus(bytes: number): SizeStatus {
  if (bytes > DISCORD_MAX_BYTES) return 'over'
  if (bytes >= DISCORD_MAX_BYTES * NEAR_LIMIT_FRACTION) return 'near'
  return 'ok'
}

/**
 * Why a channel is unavailable, phrased for the coach rather than the log.
 * Returns null when the channel can take the file.
 */
export function blockedReason(channel: DeliveryChannel, bytes: number): string | null {
  if (deliveryFitness(bytes)[channel]) return null
  if (channel === 'discord') {
    return `This recording is ${formatBytes(bytes)}. Discord only accepts ${formatBytes(
      DISCORD_MAX_BYTES,
    )} — send it by email instead, or save it to your PC.`
  }
  return `This recording is ${formatBytes(bytes)}. Most mailboxes reject anything over ${formatBytes(
    EMAIL_MAX_BYTES,
  )} — save it to your PC and share it from there.`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// State machine
//
// Explicit rather than a handful of booleans because the illegal combinations
// are the ones that cost real debugging time: recording while the preflight is
// still open, stopping something that never started, a stray stop arriving
// after finalize. Every transition below is one a real event can cause; the
// rest simply do not exist.
// ---------------------------------------------------------------------------

export type RecorderState =
  | 'idle'
  | 'preflight'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'review'

export type RecorderEvent =
  | 'open'
  | 'cancel'
  | 'start'
  | 'countdownDone'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'finalized'
  | 'discard'
  | 'failed'

const TRANSITIONS: Record<RecorderState, Partial<Record<RecorderEvent, RecorderState>>> = {
  idle: { open: 'preflight' },
  preflight: { start: 'countdown', cancel: 'idle', failed: 'idle' },
  countdown: { countdownDone: 'recording', cancel: 'idle', failed: 'idle' },
  // A failure mid-recording still goes to review: chunks are already on disk,
  // and throwing away a coach's voice-over because the stream dropped at the
  // end would be the worst possible response to it.
  recording: { pause: 'paused', stop: 'finalizing', failed: 'finalizing' },
  paused: { resume: 'recording', stop: 'finalizing', failed: 'finalizing' },
  finalizing: { finalized: 'review', failed: 'idle' },
  review: { discard: 'idle', open: 'preflight' },
}

/** Returns the next state, or null if the event does not apply — never throws. */
export function nextState(state: RecorderState, event: RecorderEvent): RecorderState | null {
  return TRANSITIONS[state][event] ?? null
}

/** True while bytes are being produced — what the pill and the meter key off. */
export function isCapturing(state: RecorderState): boolean {
  return state === 'recording' || state === 'paused'
}
