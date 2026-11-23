import type { Sample } from 'coachboard-shared/videoAnalysis'
import type { BarMotionSample } from 'coachboard-shared/barPause'
import { decodeWithMediabunny, type DecodedFrame } from './clipPose'

// ---------------------------------------------------------------------------
// The BAR's movement, measured on the bar itself (BP32, D122, D123).
//
// The plates are no measure of the pause: unclipped, they wobble on the
// sleeves, and a plate that has stopped says nothing about a bar still sinking
// into the chest. So the bar is measured where it is always in view — between
// the hands, inside the uprights — in a row of fixed columns. Only its HEIGHT
// is read: a point tracked on a smooth bar slides along it, but a height has
// nothing to slide along.
//
// In each column the bar's vertical profile (its cross-section, with a few
// pixels of whatever is behind it) is found again frame to frame — matched
// against the frame before, not the first one, because what is behind the bar
// changes completely as it comes down (wall at the top, shirt at the bottom),
// slowly enough that neighbouring frames still match. The plate's tracked path
// says where to look: the bar moves as the plate does, give or take the wobble,
// so each column is searched only a few pixels around that. Without it a
// touch-and-go turn lost the bar and the columns stayed on the shirt; matching
// against the first frame lost it as soon as the shirt was behind it. Measured
// on real sets in the spike (scratchpad barmotion.mjs) before being built.
// ---------------------------------------------------------------------------

/** A greyscale picture, one float per pixel. */
export interface Gray {
  data: Float32Array
  width: number
  height: number
}

export function toGray(img: { data: Uint8ClampedArray; width: number; height: number }): Gray {
  const data = new Float32Array(img.width * img.height)
  for (let p = 0, q = 0; q < data.length; p += 4, q++) data[q] = img.data[p] * 0.299 + img.data[p + 1] * 0.587 + img.data[p + 2] * 0.114
  return { data, width: img.width, height: img.height }
}

/** Half the cross-section's height and width, in pixels at the measuring width. */
const HALF = 14
const BAND = 3

/** The picture's value at a column and a fractional row: rows interpolated, so a sub-pixel height is a real one. */
function at(g: Gray, x: number, y: number): number {
  const y0 = Math.floor(y), f = y - y0
  const r0 = Math.min(g.height - 1, Math.max(0, y0)), r1 = Math.min(g.height - 1, Math.max(0, y0 + 1))
  return g.data[r0 * g.width + x] * (1 - f) + g.data[r1 * g.width + x] * f
}

/** The vertical cross-section through (x, y), averaged over a few columns. */
export function profileAt(g: Gray, x: number, y: number): Float32Array {
  const out = new Float32Array(2 * HALF + 1)
  for (let k = -HALF; k <= HALF; k++) {
    let s = 0
    for (let dx = -BAND; dx <= BAND; dx++) s += at(g, Math.min(g.width - 1, Math.max(0, Math.round(x) + dx)), y + k)
    out[k + HALF] = s / (2 * BAND + 1)
  }
  return out
}

/** Normalised cross-correlation of two profiles: 1 the same shape, 0 nothing alike. */
export function ncc(a: Float32Array, b: Float32Array): number {
  let ma = 0, mb = 0
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i] }
  ma /= a.length; mb /= b.length
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0
}

/**
 * Where `tpl` best matches in column x, from `below` px under y to `above` px
 * over it (or ±search when only one is given), to a sub-pixel.
 */
export function matchIn(g: Gray, x: number, tpl: Float32Array, y: number, search: number, above = search): { y: number; score: number } {
  const scores: number[] = []
  let best = -2, bi = 0
  for (let dy = -above; dy <= search; dy++) {
    const s = ncc(tpl, profileAt(g, x, y + dy))
    scores.push(s)
    if (s > best) { best = s; bi = scores.length - 1 }
  }
  // A parabola through the peak and its neighbours.
  let sub = 0
  if (bi > 0 && bi < scores.length - 1) {
    const a = scores[bi - 1], b = scores[bi], c = scores[bi + 1], den = a - 2 * b + c
    if (den < 0) sub = (0.5 * (a - c)) / den
  }
  return { y: y + (bi - above) + sub, score: best }
}

/** One column on the bar, with the profile it was last seen with. */
export interface BarColumn {
  x: number
  y: number
  profile: Float32Array
}

/** Columns this far either side of the click, as a share of the picture's width. */
const COLUMN_SPAN = 0.12
const COLUMNS_EACH_SIDE = 4
/**
 * Under this a match either side of the click does not count toward the bar's
 * line. Measured on a close-up bench: the bar itself matched 0.68-0.93 along its
 * length (knurling, highlight); the line is then agreed by the matches, so a
 * stray one above this is outvoted.
 */
const MIN_MATCH = 0.65

/**
 * Whether a cross-section has a bar in its middle: a narrow band clearly
 * lighter or darker than what is just above and below it. Without this a click
 * on a plainly shaded wall "found a bar" — the shading repeats along the wall,
 * and matching that ignores brightness finds it in every column.
 */
export function looksLikeBar(p: Float32Array): boolean {
  return barStrength(p) > 0
}

/** How clearly a cross-section has a bar in its middle; above 0 it does (see looksLikeBar). */
export function barStrength(p: Float32Array): number {
  const mid = HALF
  let centre = 0, ring = 0, nRing = 0
  for (let i = mid - 3; i <= mid + 3; i++) centre += p[i]
  centre /= 7
  for (let i = 0; i < p.length; i++) if (Math.abs(i - mid) >= 9) { ring += p[i]; nRing++ }
  ring /= nRing
  let mean = 0
  for (const v of p) mean += v
  mean /= p.length
  let sd = 0
  for (const v of p) sd += (v - mean) ** 2
  sd = Math.sqrt(sd / p.length)
  const step = Math.abs(centre - ring)
  return Math.min(step - 8, step - 0.8 * sd)
}

/**
 * The click set onto the bar: the most bar-like spot within a few pixels above
 * or below it. On screen the bar may be only five pixels tall, and a click a
 * little off it found no bar.
 */
function snapToBar(g: Gray, click: { x: number; y: number }): { x: number; y: number } {
  const reach = Math.max(6, Math.round(g.width * 0.012))
  let best = click.y, bestStrength = -Infinity
  for (let dy = -reach; dy <= reach; dy++) {
    const s = barStrength(profileAt(g, click.x, click.y + dy))
    // Ties go to the nearer spot.
    if (s > bestStrength + 1e-6 || (Math.abs(s - bestStrength) <= 1e-6 && Math.abs(dy) < Math.abs(best - click.y))) { bestStrength = s; best = click.y + dy }
  }
  return { x: click.x, y: best }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }

/**
 * The bar around the coach's click: its line found from where the click's own
 * cross-section matches either side, then columns laid evenly along that line.
 * Null when the click is not on something bar-shaped, or the matches either
 * side do not agree on a line.
 *
 * The matches only give the line, never the columns: built from the matched
 * spots themselves, a close-up bench (a 26 px bar, its look changing along its
 * length) kept three columns, one of them off the bar — and the measurement
 * read a 0.25 s pause as 1.0 s. Laid evenly along the line, as the spike did,
 * a column that lands on a hand is simply outvoted by the rest.
 */
export function findBar(g: Gray, clicked: { x: number; y: number }): BarColumn[] | null {
  const click = snapToBar(g, clicked)
  const tpl = profileAt(g, click.x, click.y)
  if (!looksLikeBar(tpl)) return null
  const step = (g.width * COLUMN_SPAN) / COLUMNS_EACH_SIDE
  // The bar may run at an angle in the picture; let each column look a fair way up and down.
  const search = Math.round(g.width * 0.04)
  const candidates: { x: number; y: number }[] = []
  for (const dir of [-1, 1]) {
    let prev = { x: click.x, y: click.y }
    for (let k = 1; k <= COLUMNS_EACH_SIDE; k++) {
      const x = Math.round(click.x + dir * k * step)
      if (x < BAND || x >= g.width - BAND) break
      const m = matchIn(g, x, tpl, prev.y, search)
      if (m.score < MIN_MATCH) continue
      candidates.push({ x, y: m.y })
      prev = { x, y: m.y }
    }
  }
  // The line through the click that most matches agree on; a stray match is left out.
  const slopeOf = (p: { x: number; y: number }) => (p.y - click.y) / (p.x - click.x)
  if (candidates.length < 2) return null
  const rough = median(candidates.map(slopeOf))
  const near = Math.max(3, g.width * 0.004)
  const agree = candidates.filter((p) => Math.abs(p.y - (click.y + rough * (p.x - click.x))) <= near)
  if (agree.length < 2) return null
  const slope = median(agree.map(slopeOf))
  const cols: BarColumn[] = []
  for (let j = -COLUMNS_EACH_SIDE; j <= COLUMNS_EACH_SIDE; j++) {
    const x = Math.round(click.x + j * step)
    if (x < BAND || x >= g.width - BAND) continue
    const y = click.y + slope * (x - click.x)
    cols.push({ x, y, profile: profileAt(g, x, y) })
  }
  return cols.length >= 3 ? cols : null
}

/**
 * One frame on: each column searched `search` px either side of where the
 * predictions put it; the bar moved by the median of the columns that matched
 * well, and every column moves by that, so one that slipped (onto a hand) is
 * put back.
 *
 * Two predictions, and the search covers both: the plate's movement (the guide
 * that carries the bar through a fast turn) and the bar's own last movement.
 * Trusting the plate alone, one glitch in its track sent the search away from
 * the bar for a frame; the bar lagged from there and was lost in the slow last
 * part of the descent, and a 0.25 s pause read 0.7 s.
 */
export function stepBar(cols: BarColumn[], g: Gray, predictedDy: number, search: number, ownDy = predictedDy): { dy: number; good: number } {
  const lo = Math.min(predictedDy, ownDy), hi = Math.max(predictedDy, ownDy)
  const centre = (lo + hi) / 2, half = (hi - lo) / 2
  const reach = Math.round(search + half)
  const moves = cols.map((c) => {
    const m = matchIn(g, c.x, c.profile, c.y + centre, reach)
    return { dy: m.y - c.y, score: m.score }
  })
  const ok = moves.filter((m) => m.score > 0.8)
  const use = ok.length >= 3 ? ok : moves
  const ds = use.map((m) => m.dy).sort((a, b) => a - b)
  const dy = ds[ds.length >> 1]
  for (const c of cols) { c.y += dy; c.profile = profileAt(g, c.x, c.y) }
  return { dy, good: ok.length }
}

/** The plate's height at time t, interpolated along its tracked path. */
export function heightAt(track: Sample[], t: number): number {
  if (track.length === 0) return 0
  if (t <= track[0].t) return track[0].y
  const last = track[track.length - 1]
  if (t >= last.t) return last.y
  let lo = 0, hi = track.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m].t <= t) lo = m; else hi = m }
  const f = (t - track[lo].t) / (track[hi].t - track[lo].t)
  return track[lo].y + f * (track[hi].y - track[lo].y)
}

/** The width the bar is measured at: the clip's own, capped — a bar is a dozen pixels thick at this. */
const MAX_WIDTH = 1440

export interface MeasureBarOptions {
  /** The file for a local clip, the URL for one the app serves. */
  source: { blob: Blob } | { url: string }
  videoWidth: number
  /** Where the coach clicked the bar, in video pixels, and when. */
  click: { t: number; x: number; y: number }
  /** The plate's tracked path, video pixels: the guide. */
  plate: Sample[]
  /** The stretch to measure: the tracked range. */
  from: number
  to: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export class BarNotFoundError extends Error {
  constructor() {
    super('The bar was not found there. Click on the bar itself, between the hands.')
  }
}

export class BarUnreadableError extends Error {
  constructor() {
    super('This video cannot be read frame by frame here, so the pause cannot be measured on it.')
  }
}

/**
 * Every frame in [from, to], decoded with mediabunny. No fallback to seeking the
 * player, unlike the skeleton: a seek can hand back the frame before, and a
 * measurement of stillness built on repeated frames invents stillness — tried,
 * it lost the bar entirely. No answer is better than that one.
 */
async function frames(opts: MeasureBarOptions, width: number, from: number, to: number): Promise<AsyncIterable<DecodedFrame>> {
  try {
    const it = decodeWithMediabunny(opts.source, { width, from, to })
    const head = await it.next()
    if (head.done) throw new Error('nothing decoded')
    return (async function* () {
      yield head.value
      yield* it
    })()
  } catch {
    throw new BarUnreadableError()
  }
}

const grayOf = (f: DecodedFrame): Gray => {
  const ctx = f.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  return toGray(ctx.getImageData(0, 0, f.canvas.width, f.canvas.height))
}

/**
 * The bar's movement frame to frame over [from, to], in video pixels (down
 * positive). Throws BarNotFoundError when the click was not on the bar.
 */
export async function measureBarMotion(opts: MeasureBarOptions): Promise<BarMotionSample[]> {
  const width = Math.min(opts.videoWidth, MAX_WIDTH)
  const k = width / opts.videoWidth
  // The bar where the coach clicked it.
  let clickFrame: DecodedFrame | null = null
  for await (const f of await frames(opts, width, Math.max(0, opts.click.t - 0.02), opts.click.t + 0.1)) { clickFrame = f; break }
  if (!clickFrame) throw new BarNotFoundError()
  const clickGray = grayOf(clickFrame)
  const cols = findBar(clickGray, { x: opts.click.x * k, y: opts.click.y * k })
  if (!cols) throw new BarNotFoundError()

  const out: BarMotionSample[] = []
  const search = Math.max(6, Math.round(12 * (width / MAX_WIDTH)))
  let prevT: number | null = null
  let ownDy = 0
  let started = false
  for await (const f of await frames(opts, width, opts.from, opts.to)) {
    if (opts.signal?.aborted) break
    const g = grayOf(f)
    if (!started) {
      // Carried from the click to the first frame by the plate, then set on the bar there.
      const shift = (heightAt(opts.plate, f.t) - heightAt(opts.plate, opts.click.t)) * k
      for (const c of cols) {
        const m = matchIn(g, c.x, c.profile, c.y + shift, Math.round(search * 1.5))
        c.y = m.y
        c.profile = profileAt(g, c.x, c.y)
      }
      started = true
      prevT = f.t
      continue
    }
    const predicted = (heightAt(opts.plate, f.t) - heightAt(opts.plate, prevT!)) * k
    const { dy } = stepBar(cols, g, predicted, search, ownDy)
    ownDy = dy
    out.push({ t: f.t, dy: dy / k })
    prevT = f.t
    if (opts.to > opts.from) opts.onProgress?.(Math.min(1, (f.t - opts.from) / (opts.to - opts.from)))
  }
  return out
}
