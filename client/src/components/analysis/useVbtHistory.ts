import { useEffect, useMemo, useState } from 'react'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import {
  bestRepVelocity,
  lastRepVelocity,
  type LrvAnchor,
  type LvPoint,
  type VbtLift,
  type VelocityMetric,
} from 'coachboard-shared/vbt'

/**
 * What this athlete has previously tracked on one lift, as the two kinds of
 * anchor the VBT math takes.
 *
 * Lives outside VelocityPanel because the page needs the same anchors: it labels
 * each row of the rep table with an estimated RPE, and reading those off the
 * published chart while the panel's headline reads off the athlete's own would
 * put two different numbers on the same rep.
 *
 * The current, unsaved set is deliberately NOT included — callers add it, since
 * only they know whether its load and called RPE have been filled in yet.
 */
export function useVbtHistory(
  athleteId: string | null,
  lift: VbtLift,
  metric: VelocityMetric,
): { anchors: LrvAnchor[]; points: LvPoint[] } {
  const [rows, setRows] = useState<VideoAnalysisDto[]>([])

  useEffect(() => {
    if (!athleteId) {
      setRows([])
      return
    }
    let cancelled = false
    // withTrack=0 matters: this list is read only for the load and per-rep
    // metrics on each row, and shipping every tracked path with it would be
    // megabytes to draw a handful of dots.
    fetch(`/api/analysis?athleteId=${encodeURIComponent(athleteId)}&withTrack=0`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('history unavailable'))))
      .then((data: VideoAnalysisDto[]) => !cancelled && setRows(data))
      // A missing history is not worth a toast — everything downstream falls
      // back to the published reference values, which is its default anyway.
      .catch(() => !cancelled && setRows([]))
    return () => {
      cancelled = true
    }
  }, [athleteId])

  return useMemo(() => {
    const anchors: LrvAnchor[] = []
    const points: LvPoint[] = []

    for (const row of rows) {
      if (row.lift !== lift) continue
      const metrics = row.metrics ?? []
      // The last rep is what an RPE is called on; the fastest is what a
      // load-velocity profile is built from.
      const last = lastRepVelocity(metrics, metric)
      const best = bestRepVelocity(metrics, metric)
      if (row.calledRpe != null && last != null) anchors.push({ rpe: row.calledRpe, velocity: last })
      if (row.loadKg != null && best != null) {
        points.push({ load: row.loadKg, velocity: best, label: row.createdAt.slice(0, 10) })
      }
    }
    return { anchors, points }
  }, [rows, lift, metric])
}

/**
 * The athlete's recorded maxes, so a velocity estimate can be calibrated against
 * a real one instead of a population slope.
 *
 * Only `lift_name` and `weight` are kept — the rest of an `AthleteMax` row is of
 * no use here, and matching a free-text name to a VBT lift is `recordedMaxFor`'s
 * job rather than this hook's.
 */
export function useAthleteMaxes(athleteId: string | null): { lift_name: string; weight: number }[] {
  const [maxes, setMaxes] = useState<{ lift_name: string; weight: number }[]>([])

  useEffect(() => {
    if (!athleteId) {
      setMaxes([])
      return
    }
    let cancelled = false
    fetch(`/api/athletes/${encodeURIComponent(athleteId)}/maxes`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setMaxes(Array.isArray(data) ? data : [])
      })
      // No maxes on file simply means no calibration — the estimate falls back
      // to a population slope and says so.
      .catch(() => !cancelled && setMaxes([]))
    return () => {
      cancelled = true
    }
  }, [athleteId])

  return maxes
}
