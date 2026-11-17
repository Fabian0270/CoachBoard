import { MID_FOOT_LIFTS, repMidFoot, type PoseFrame, type RepMidFoot } from 'coachboard-shared/pose'
import type { RepMetrics, Sample } from 'coachboard-shared/videoAnalysis'
import { repWindows } from './pathPaint'

/**
 * Bar over mid-foot per rep, keyed by rep index, for the rep table (BP31, D58).
 * Null when the lift is not a squat or deadlift kind or there is no skeleton.
 */
export function midFootByRep(
  lift: string | null,
  frames: PoseFrame[] | null | undefined,
  track: Sample[] | null | undefined,
  reps: RepMetrics[],
  pixelsPerMetre: number | null,
): Map<number, RepMidFoot | null> | null {
  if (!lift || !MID_FOOT_LIFTS.includes(lift) || !frames?.length || !track || track.length < 2 || reps.length === 0) return null
  const sorted = [...reps].sort((a, b) => a.startT - b.startT)
  const per = repMidFoot(frames, track, repWindows(sorted, track[0].t), pixelsPerMetre)
  // No foot seen in any rep: no column, rather than a column of dashes.
  if (per.every((p) => p == null)) return null
  return new Map(sorted.map((r, i) => [r.index, per[i]]))
}
