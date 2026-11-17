import { looksMistracked, type RepMetrics } from 'coachboard-shared/videoAnalysis'
import { readRep, type VelocityMetric } from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// A set against the athlete's earlier ones: the last set at the same load
// (BP29, D53) and whether this one is the fastest at that load so far (BP35,
// D54). Only sets of the same lift at EXACTLY the same kilos count.
// ---------------------------------------------------------------------------

export interface HistorySet {
  id: string
  lift: string | null
  loadKg: number | null
  createdAt: string
  metrics: RepMetrics[]
}

const sameLoad = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 1e-6

/** The athlete's sets of this lift at this load, saved before this one, newest first. */
function earlierAtLoad(rows: HistorySet[], current: Pick<HistorySet, 'id' | 'lift' | 'loadKg' | 'createdAt'>) {
  return rows
    .filter((r) => r.id !== current.id && r.lift === current.lift && current.lift != null && sameLoad(r.loadKg, current.loadKg) && r.createdAt < current.createdAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** The most recent earlier set of the same lift at exactly the same load (D53), or null. */
export function lastTimeAtLoad(rows: HistorySet[], current: Pick<HistorySet, 'id' | 'lift' | 'loadKg' | 'createdAt'>): HistorySet | null {
  return earlierAtLoad(rows, current)[0] ?? null
}

/** A set's fastest counted rep in m/s, leaving out reps that look mistracked — a tracker jump is not a PR. */
export function bestCleanRep(reps: RepMetrics[], metric: VelocityMetric): number | null {
  const speeds = reps.filter((r) => !looksMistracked(r)).map((r) => readRep(r, metric)).filter((v): v is number => v != null)
  return speeds.length ? Math.max(...speeds) : null
}

export type VelocityPr =
  | { kind: 'pr'; best: number; previous: number }
  | { kind: 'first'; best: number }
  | null

/**
 * Whether this set is the athlete's fastest at this load so far (D54): its
 * fastest counted rep, in the speed the set is read from, against every
 * earlier set of the lift at the same kilos. "first" when there is no earlier
 * one to beat; null without a scale or when it was not faster.
 */
export function velocityPr(rows: HistorySet[], current: HistorySet, metric: VelocityMetric): VelocityPr {
  const best = bestCleanRep(current.metrics, metric)
  if (best == null || current.loadKg == null || current.lift == null) return null
  const earlier = earlierAtLoad(rows, current)
    .map((r) => bestCleanRep(r.metrics, metric))
    .filter((v): v is number => v != null)
  if (earlier.length === 0) return { kind: 'first', best }
  const previous = Math.max(...earlier)
  return best > previous ? { kind: 'pr', best, previous } : null
}
