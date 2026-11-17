import type { Point, Stroke } from './annotations'

// ---------------------------------------------------------------------------
// Painting the bar path, its dot and the coach's pen marks over a picture.
//
// One painter for the stage over the playing video and for a clip saved with
// the path drawn in (BP25), so the saved clip shows exactly what the coach saw.
// Coordinates come in VIDEO pixels; `scale` takes them to the canvas, and `k`
// thickens every line for a canvas larger than the screen's.
// ---------------------------------------------------------------------------

export type PaintContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

interface TimedPoint { t: number; x: number; y: number }

/**
 * Each rep as a stretch of the clip: from the top before it (the end of the
 * rep before, or the start of the path) down to its bottom and back up.
 */
export function repWindows(reps: { startT: number; endT: number }[], pathStart: number) {
  const sorted = [...reps].sort((a, b) => a.startT - b.startT)
  return sorted.map((r, i) => ({ from: i ? sorted[i - 1].endT : pathStart, bottom: r.startT, to: r.endT }))
}

/** The coach's freehand marks, under everything else. */
export function paintStrokes(ctx: PaintContext, strokes: Stroke[], scale: number, k = 1) {
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue
    const trace = () => {
      ctx.beginPath()
      stroke.points.forEach((p, i) =>
        i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale),
      )
      ctx.stroke()
    }
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // Same dark casing as the bar path: gym footage contains something every
    // colour disappears into somewhere.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.lineWidth = 6 * k
    trace()
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = 3.5 * k
    trace()
  }
}

/**
 * The path. With the reps known (a finished track), the reps are drawn apart
 * (BP9): the others dimmed, the rep under the playhead bright, its way down
 * lighter than its way up. Without them, the whole path as one line.
 */
export function paintPath(
  ctx: PaintContext,
  opts: { path: TimedPoint[]; reps?: { startT: number; endT: number }[] | null; playhead: number; color: string; scale: number; k?: number },
) {
  const { path, reps, playhead, color, scale, k = 1 } = opts
  if (path.length < 2) return
  const trace = (from = -Infinity, to = Infinity) => {
    ctx.beginPath()
    let started = false
    for (const s of path) {
      if (s.t < from || s.t > to) continue
      if (started) ctx.lineTo(s.x * scale, s.y * scale)
      else { ctx.moveTo(s.x * scale, s.y * scale); started = true }
    }
    ctx.stroke()
  }
  /** Casing, then the colour: whichever colour the coach picks, gym footage contains something it blends into. */
  const cased = (width: number, from?: number, to?: number) => {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.lineWidth = (width + 2.5) * k
    trace(from, to)
    ctx.strokeStyle = color
    ctx.lineWidth = width * k
    trace(from, to)
  }
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const windows = reps?.length ? repWindows(reps, path[0].t) : null
  const current = windows?.find((w) => playhead >= w.from && playhead <= w.to) ?? null
  if (windows && current) {
    ctx.globalAlpha = 0.3
    cased(2)
    ctx.globalAlpha = 0.6
    cased(2.5, current.from, current.bottom)
    ctx.globalAlpha = 1
    cased(3.5, current.bottom, current.to)
  } else {
    // The whole path, so a track that wandered off the bar is obvious at a
    // glance. Quality numbers cannot be trusted to reveal that on their own.
    cased(2.5)
  }
}

/** The dot riding the bar. */
export function paintDot(ctx: PaintContext, point: Point, color: string, scale: number, k = 1) {
  const cx = point.x * scale
  const cy = point.y * scale
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = 4 * k
  ctx.beginPath()
  ctx.arc(cx, cy, 9 * k, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = 2 * k
  ctx.beginPath()
  ctx.arc(cx, cy, 9 * k, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(cx, cy, 3 * k, 0, Math.PI * 2)
  ctx.fill()
}

/** The tracked sample nearest a moment, for the dot. */
export function sampleAt<T extends { t: number }>(samples: T[], t: number): T | null {
  if (!samples.length) return null
  return samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best))
}
