// ---------------------------------------------------------------------------
// Drawing on the lift with a pen.
//
// Every coordinate is in ORIGINAL VIDEO PIXELS, the same as the bar path, the
// seed and the calibration line. That is the invariant the whole stage is built
// on: it survives resizing the window, and it is what keeps a mark on the
// lifter's knee when the clip goes fullscreen.
//
// The geometry lives here rather than in the component because it is the only
// part that can be tested — this repo has no jsdom, so anything touching a
// canvas is verified by hand.
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

/** One freehand stroke. */
export interface Stroke {
  color: string
  points: Point[]
}

/**
 * Drops points a stroke does not need.
 *
 * A pointer moving across the frame emits a point per animation frame, so a
 * two-second scribble is hundreds of them — most sitting on a line between
 * their neighbours. Ramer–Douglas–Peucker keeps the corners and discards the
 * rest, which matters because every surviving point is redrawn on every frame
 * of the rAF loop that is also drawing the bar path.
 *
 * `tolerance` is in video pixels: a point survives if removing it would move
 * the stroke by more than that.
 */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2 || !(tolerance > 0)) return points.slice()

  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  // Iterative rather than recursive: a long stroke on a slow machine can run to
  // thousands of points, and the recursion depth is the one thing here that
  // could take the renderer down.
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let worst = 0
    let worstIndex = -1
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last])
      if (d > worst) {
        worst = d
        worstIndex = i
      }
    }
    if (worst > tolerance && worstIndex > 0) {
      keep[worstIndex] = true
      stack.push([first, worstIndex], [worstIndex, last])
    }
  }

  return points.filter((_, i) => keep[i])
}

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  // A degenerate segment (the stroke doubled back exactly) has no perpendicular
  // to measure against, so fall back to plain distance from the endpoint.
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.hypot(dx, dy)
}

/**
 * Whether a stroke is worth keeping once the pointer lifts.
 *
 * A click that was never a drag should leave nothing behind, or every stray tap
 * on the frame becomes an invisible mark sitting in the undo stack.
 */
export function isDrawable(stroke: Stroke): boolean {
  return stroke.points.length > 1
}
