// ---------------------------------------------------------------------------
// The bench pause, measured from the BAR (BP32, D122).
//
// The powerlifting rule: the bar must be motionless on the chest before the
// press. So the pause is from the moment the bar is completely still until it
// starts up — measured on the bar itself, never the plates: without collars
// the plates wobble on the sleeves, and a plate that has stopped says nothing
// about a bar still sinking into the chest (seen on a real set: the plate
// still at 1.5 s while the bar sank another 2-3 cm and was still for 1.0 s).
//
// Input is the bar's movement frame to frame (barMeasure.ts measures it). A
// frame counts as still when the bar moved less than BAR_STILL_SHARE of the
// rep's range per frame, averaged over it and the two frames before — about
// 2.5 cm/s on a bench, which is invisible on screen; a slow last settle into
// the chest reads as still, as a referee would see it. Checked on real sets
// against the frames by eye: 0.57 / 0.43 / 1.10 s against about 0.6 / 0.45 /
// 1.0-1.1 s, a touch-and-go rep 0, and a short pause 0.23 s against 0.25.
// ---------------------------------------------------------------------------

/** How far the bar moved down (+) or up (−) since the frame before, in video pixels. */
export interface BarMotionSample {
  t: number
  dy: number
}

/** Under this share of the rep's range per frame, the bar is still. */
export const BAR_STILL_SHARE = 0.002

export interface BarPause {
  pauseMs: number
  /** When the bar was first completely still, and when it started up. Equal for touch-and-go. */
  fromT: number
  toT: number
}

/**
 * One rep's pause from the bar's movement around its bottom. `rep.startT` is
 * where the tracked path says the press began (from the plate); the bar's own
 * start up is found near it. Null when there is no movement to read there.
 */
export function barPause(
  motion: BarMotionSample[],
  rep: { startT: number; romPx: number },
): BarPause | null {
  // From well before the bottom to just after the press began.
  const window = motion.filter((m) => m.t >= rep.startT - 2.5 && m.t <= rep.startT + 0.6)
  const n = window.length
  if (n < 8 || !(rep.romPx > 0)) return null
  const still = rep.romPx * BAR_STILL_SHARE

  // Where the bar was, relative to the window's start, to find the bottom.
  const y: number[] = []
  let acc = 0
  for (const m of window) { acc += m.dy; y.push(acc) }
  let deepest = 0
  for (let i = 1; i < n; i++) if (y[i] > y[deepest]) deepest = i

  // The bar's start up: the first frame after the bottom that it moves up faster than "still".
  let go = deepest + 1
  while (go < n && -window[go].dy <= still) go++
  if (go >= n) return null

  // Back from there while still: the frame and the two before it all slow on average.
  const avg = (i: number) => {
    const a = window[Math.max(0, i - 2)].dy, b = window[Math.max(0, i - 1)].dy, c = window[i].dy
    return (Math.abs(a) + Math.abs(b) + Math.abs(c)) / 3
  }
  let start = go - 1
  if (start < 0 || avg(start) >= still) return { pauseMs: 0, fromT: window[go].t, toT: window[go].t }
  while (start > 0 && avg(start - 1) < still) start--
  // A frame is still when it and the two before it are slow, so the run began two frames earlier.
  start = Math.max(0, start - 2)
  return { pauseMs: Math.round((window[go].t - window[start].t) * 1000), fromT: window[start].t, toT: window[go].t }
}
