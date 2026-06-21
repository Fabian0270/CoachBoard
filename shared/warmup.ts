// Warm-up ladder for working up to a target 1RM.
//
// Reproduces StrengthLog's "How to warm up for a 1RM attempt" protocol exactly:
// seven warm-up sets ramping 40% → 95% with descending reps and rising rest,
// then the max single at 100%. Weights are a percentage of the target 1RM,
// rounded to the nearest plate increment (2.5 kg by default) and floored at the
// empty bar. Source: strengthlog.com/how-to-warm-up-for-a-1rm-attempt-calculator/

export interface WarmupStep {
  /** Percentage of the target 1RM (e.g. 40 means 40%). */
  pct: number
  reps: number
  /** Rest after this set, in minutes. null on the final max attempt. */
  restMinutes: number | null
  /** True for the 100% max attempt row (not a warm-up). */
  isMax: boolean
}

/** The fixed StrengthLog 1RM-attempt protocol, as data. */
export const WARMUP_SCHEME: readonly WarmupStep[] = [
  { pct: 40, reps: 8, restMinutes: 1, isMax: false },
  { pct: 50, reps: 5, restMinutes: 2, isMax: false },
  { pct: 60, reps: 4, restMinutes: 2, isMax: false },
  { pct: 70, reps: 3, restMinutes: 2, isMax: false },
  { pct: 80, reps: 2, restMinutes: 3, isMax: false },
  { pct: 90, reps: 1, restMinutes: 3, isMax: false },
  { pct: 95, reps: 1, restMinutes: 5, isMax: false },
  { pct: 100, reps: 1, restMinutes: null, isMax: true },
]

export interface WarmupOptions {
  /** Plate increment to round each weight to. Default 2.5 kg. */
  rounding?: number
  /** Empty bar weight; warm-up weights never drop below it. Default 20 kg. */
  barWeight?: number
}

export interface WarmupSet extends WarmupStep {
  /** Loaded weight for the set, after rounding and bar floor. */
  weight: number
}

function roundTo(value: number, increment: number): number {
  if (!(increment > 0)) return value
  return Math.round(value / increment) * increment
}

/**
 * Build the warm-up ladder for a target 1RM. Returns one row per scheme step
 * (seven warm-ups + the max attempt). Returns [] for a non-positive 1RM.
 */
export function warmupPlan(oneRM: number, opts: WarmupOptions = {}): WarmupSet[] {
  if (!(oneRM > 0)) return []
  const rounding = opts.rounding ?? 2.5
  const barWeight = opts.barWeight ?? 20
  return WARMUP_SCHEME.map((step) => {
    const raw = (oneRM * step.pct) / 100
    // The max attempt is the literal target; warm-ups round to plates and never
    // sit below the empty bar.
    const weight = step.isMax
      ? roundTo(oneRM, rounding)
      : Math.max(barWeight, roundTo(raw, rounding))
    return { ...step, weight }
  })
}

// ── 1RM estimation (StrengthLog uses Epley) ─────────────────────────────────
// 1RM = weight × (1 + reps / 30)

/** Epley estimated 1RM from a weight × reps set. Returns null for bad input. */
export function epley1RM(weight: number, reps: number): number | null {
  if (!(weight > 0) || !(reps >= 1)) return null
  return weight * (1 + reps / 30)
}

// ── Plate loading (per side of the bar) ─────────────────────────────────────

/** Standard kg plates, heaviest first. */
export const KG_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25] as const

/**
 * Greedy plate breakdown for one side of the bar. Any remainder that can't be
 * made from the available plates is ignored (the rounded warm-up weights are
 * always loadable with these plates at a 1.25 kg resolution).
 */
export function platesPerSide(
  weight: number,
  barWeight = 20,
  plates: readonly number[] = KG_PLATES,
): number[] {
  let perSide = (weight - barWeight) / 2
  if (!(perSide > 0)) return []
  const result: number[] = []
  for (const plate of plates) {
    while (perSide >= plate - 1e-9) {
      result.push(plate)
      perSide -= plate
    }
  }
  return result
}
