// ---------------------------------------------------------------------------
// Velocity targets on a program row (BP39, D71–D75).
//
// The coach types one cell, the way they type Intensity: a speed ("0.50"), a
// range ("0.45-0.55"), a velocity-loss cut-off ("VL 20%"), or a speed and a
// cut-off together ("0.50 · VL 20%"). The text is stored and exported as typed;
// this reads it, and judges a tracked set against it.
//
// One speed means at least that fast; a range means inside it (D75). Every
// counted rep is held against the speed. Velocity loss is each rep's drop from
// the fastest rep before it; the set should have stopped at the first rep that
// reached the cut-off, and the reps after it are past it (D74).
// ---------------------------------------------------------------------------

import { readRep, type VelocityMetric } from './vbt.js'
import type { RepMetrics } from './videoAnalysis.js'

export interface VelocityTarget {
  /** m/s; null when the cell has no speed. */
  min: number | null
  /** m/s; null for "at least min". */
  max: number | null
  /** Velocity-loss cut-off, percent; null when the cell has none. */
  lossPct: number | null
}

/** A speed anyone would type, in m/s. Anything else in the cell is not a speed. */
const PLAUSIBLE = (v: number) => v > 0 && v <= 3

const num = (s: string) => Number(s.replace(',', '.'))

/**
 * Reads a Velocity cell; null when it holds neither a speed nor a cut-off.
 * Accepts "0.50", "0,5", ".5 m/s", "≥0.5", "0.45-0.55", "0.45–0.55",
 * "0.45 to 0.55", "VL 20%", "20%", "-20 %", and any of those together.
 */
export function parseVelocityTarget(text: string | null | undefined): VelocityTarget | null {
  if (!text || !text.trim()) return null
  let rest = text.toLowerCase()

  let lossPct: number | null = null
  const loss = /-?\s*(\d+(?:[.,]\d+)?)\s*%/.exec(rest)
  if (loss) {
    const v = num(loss[1])
    if (v > 0 && v < 100) lossPct = v
    rest = rest.replace(loss[0], ' ')
  }

  let min: number | null = null
  let max: number | null = null
  const range = /(\d*[.,]?\d+)\s*(?:-|–|—|to)\s*(\d*[.,]?\d+)/.exec(rest)
  if (range && PLAUSIBLE(num(range[1])) && PLAUSIBLE(num(range[2]))) {
    min = Math.min(num(range[1]), num(range[2]))
    max = Math.max(num(range[1]), num(range[2]))
  } else {
    const one = /(\d*[.,]?\d+)/.exec(rest)
    if (one && PLAUSIBLE(num(one[1]))) min = num(one[1])
  }

  return min == null && lossPct == null ? null : { min, max, lossPct }
}

/** "0.50 m/s or faster · stop at 20 % loss" */
export function describeTarget(t: VelocityTarget): string {
  const speed = t.min == null ? null : t.max == null ? `${t.min.toFixed(2)} m/s or faster` : `${t.min.toFixed(2)}–${t.max.toFixed(2)} m/s`
  const loss = t.lossPct == null ? null : `stop at ${t.lossPct} % loss`
  return [speed, loss].filter(Boolean).join(' · ')
}

/** How one rep stood against the target. */
export type RepMark = 'slow' | 'fast' | 'cutoff' | 'past-cutoff'

export interface TargetVerdict {
  /** Reps read against the speed, and how many were inside it; null without a speed. */
  speed: { inside: number; total: number; slowest: number | null } | null
  /** The rep (1-based) whose loss first reached the cut-off; null if none did, or no cut-off. */
  cutoffAt: number | null
  /** Each rep's loss from the fastest rep before it, percent, by rep index. */
  losses: Map<number, number>
  /** Rep index → its mark, for the rep table. Reps that met everything are absent. */
  marks: Map<number, RepMark[]>
}

/**
 * Judges a set's counted reps (in order, struck-off ones already removed)
 * against a target, in the set's velocity metric.
 */
export function judgeSet(reps: RepMetrics[], metric: VelocityMetric, target: VelocityTarget): TargetVerdict {
  const marks = new Map<number, RepMark[]>()
  const mark = (index: number, m: RepMark) => marks.set(index, [...(marks.get(index) ?? []), m])
  const read = reps.map((r) => ({ index: r.index, v: readRep(r, metric) }))

  let speed: TargetVerdict['speed'] = null
  if (target.min != null) {
    let inside = 0
    let total = 0
    let slowest: number | null = null
    for (const { index, v } of read) {
      if (v == null) continue
      total++
      slowest = slowest == null ? v : Math.min(slowest, v)
      if (v < target.min) mark(index, 'slow')
      else if (target.max != null && v > target.max) mark(index, 'fast')
      else inside++
    }
    speed = { inside, total, slowest }
  }

  const losses = new Map<number, number>()
  let cutoffAt: number | null = null
  let best = 0
  read.forEach(({ index, v }, i) => {
    if (v == null) return
    best = Math.max(best, v)
    const loss = best > 0 ? (1 - v / best) * 100 : 0
    losses.set(index, loss)
    if (target.lossPct == null) return
    if (cutoffAt != null) mark(index, 'past-cutoff')
    else if (loss >= target.lossPct) {
      cutoffAt = i + 1
      mark(index, 'cutoff')
    }
  })

  return { speed, cutoffAt, losses, marks }
}
