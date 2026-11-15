import type { BubbleCorner } from './compositor'

// ---------------------------------------------------------------------------
// The edits a coach can make to a recording after stopping: where the webcam
// circle sits (or whether it shows at all), how big it is, and where the video
// starts and ends.
//
// Pure geometry and rules, no DOM and no video — the editor preview and the
// export both draw from these, so what the coach sees while dragging is what
// the exported file contains.
// ---------------------------------------------------------------------------

/**
 * Where the webcam circle is. One placement for the whole video.
 *
 * Fractions, not pixels, so the same placement means the same thing in the
 * small preview and in the full-size export.
 */
export interface WebcamPlacement {
  /** Centre of the circle, as a fraction of the frame's width (0 = left edge). */
  x: number
  /** Centre of the circle, as a fraction of the frame's height (0 = top edge). */
  y: number
  /** Diameter, as a fraction of the frame's SHORT edge — so it is a circle in any aspect ratio. */
  size: number
  /** Leave the webcam out of the video entirely. */
  hidden: boolean
}

/** The part of the recording to keep, in seconds of the original. */
export interface Trim {
  start: number
  end: number
}

/** The size the circle had when it was drawn in during recording. */
export const DEFAULT_BUBBLE_SIZE = 0.22
export const MIN_BUBBLE_SIZE = 0.1
export const MAX_BUBBLE_SIZE = 0.6
/** Gap to the frame edge for the corner positions, as a fraction of the short edge. */
const CORNER_MARGIN = 0.03

/** The shortest video a trim may leave. */
export const MIN_TRIM_SECONDS = 0.5
/** Differences smaller than this are not a trim — the handles were never moved. */
const TRIM_EPSILON = 0.05

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The circle in pixels for a frame of the given size. */
export function bubbleCircle(
  placement: WebcamPlacement,
  width: number,
  height: number,
): { cx: number; cy: number; radius: number } {
  const radius = (Math.min(width, height) * placement.size) / 2
  return { cx: placement.x * width, cy: placement.y * height, radius }
}

/**
 * Keeps the circle a legal size and fully inside the frame. A webcam hanging
 * off the edge of the video is never what was meant; it is a drag that went a
 * little too far.
 */
export function clampPlacement(placement: WebcamPlacement, width: number, height: number): WebcamPlacement {
  const size = clamp(placement.size, MIN_BUBBLE_SIZE, MAX_BUBBLE_SIZE)
  if (!(width > 0) || !(height > 0)) return { ...placement, size }
  const radius = (Math.min(width, height) * size) / 2
  const rx = radius / width
  const ry = radius / height
  return {
    ...placement,
    size,
    x: clamp(placement.x, rx, 1 - rx),
    y: clamp(placement.y, ry, 1 - ry),
  }
}

/** Where the circle starts: the corner it used to be drawn in, at the old size. */
export function placementFromCorner(corner: BubbleCorner, width: number, height: number): WebcamPlacement {
  const short = Math.min(width, height)
  const inset = short * (CORNER_MARGIN + DEFAULT_BUBBLE_SIZE / 2)
  const right = corner === 'bottom-right' || corner === 'top-right'
  const bottom = corner === 'bottom-right' || corner === 'bottom-left'
  return clampPlacement(
    {
      x: width > 0 ? (right ? width - inset : inset) / width : 0.5,
      y: height > 0 ? (bottom ? height - inset : inset) / height : 0.5,
      size: DEFAULT_BUBBLE_SIZE,
      hidden: false,
    },
    width,
    height,
  )
}

/** A trim that covers a real, long-enough span of a video of the given length. */
export function clampTrim(trim: Trim, duration: number): Trim {
  if (!(duration > 0)) return { start: 0, end: 0 }
  const minLength = Math.min(MIN_TRIM_SECONDS, duration)
  const start = clamp(trim.start, 0, duration - minLength)
  const end = clamp(trim.end, start + minLength, duration)
  return { start, end }
}

/** Whether the trim actually cuts anything off. */
export function isTrimmed(trim: Trim, duration: number): boolean {
  return trim.start > TRIM_EPSILON || trim.end < duration - TRIM_EPSILON
}

/**
 * Whether the recording has to be rebuilt before it can be saved or sent.
 *
 * It does when the webcam has to be drawn in (it is recorded separately now) or
 * when something is cut off. Otherwise the screen recording IS the video, and
 * saving stays instant.
 */
export function needsExport(opts: {
  hasCamera: boolean
  placement: WebcamPlacement
  trim: Trim
  duration: number
}): boolean {
  return (opts.hasCamera && !opts.placement.hidden) || isTrimmed(opts.trim, opts.duration)
}

/**
 * The square region of a webcam frame that fills the circle: a centred crop, so
 * a 16:9 webcam is not squashed.
 */
export function coverSquare(srcWidth: number, srcHeight: number): { sx: number; sy: number; size: number } {
  const size = Math.min(srcWidth, srcHeight)
  return { sx: (srcWidth - size) / 2, sy: (srcHeight - size) / 2, size }
}

/** Width of the rim around the circle, in pixels. Without it a dim room on a dark screen has no edge. */
export function rimWidth(width: number, height: number): number {
  return Math.max(2, Math.round(Math.min(width, height) * 0.004))
}
