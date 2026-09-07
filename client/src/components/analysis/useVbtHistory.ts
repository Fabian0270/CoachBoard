import { useCallback, useEffect, useMemo, useState } from 'react'
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

export interface AthleteMvt {
  /** Measured 1RM bar speed by lift id. A lift is absent until one is stored. */
  byLift: Record<string, number>
  /** Record, replace, or (with null) clear one lift's value. */
  save: (lift: VbtLift, velocity: number | null) => Promise<void>
}

/**
 * The athlete's own measured 1RM bar speed, per lift.
 *
 * A hook rather than a fetch inside the velocity panel because three pages read
 * this number and the analysis page also has to compare against it when a set
 * measures a new one. While it lived in the panel, reopening or comparing a set
 * silently fell back to the published 0.25 m/s and reported a different
 * estimated 1RM for the same lift.
 *
 * `save` updates `byLift` itself instead of refetching: the server's reply is
 * the row we just wrote, and a round trip would leave the field the coach is
 * looking at showing the old number.
 */
export function useAthleteMvt(athleteId: string | null): AthleteMvt {
  const [byLift, setByLift] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!athleteId) {
      setByLift({})
      return
    }
    let cancelled = false
    fetch(`/api/athletes/${encodeURIComponent(athleteId)}/mvt`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: unknown) => {
        if (cancelled) return
        // A hand-edited row could put anything here, and every downstream
        // consumer divides by it.
        const clean: Record<string, number> = {}
        if (data && typeof data === 'object') {
          for (const [lift, velocity] of Object.entries(data)) {
            if (typeof velocity === 'number' && Number.isFinite(velocity)) clean[lift] = velocity
          }
        }
        setByLift(clean)
      })
      // Nothing stored is the normal case for a new athlete, and it reads the
      // same as a failed fetch: fall back to the published band.
      .catch(() => !cancelled && setByLift({}))
    return () => {
      cancelled = true
    }
  }, [athleteId])

  const save = useCallback(
    async (lift: VbtLift, velocity: number | null) => {
      if (!athleteId) return
      const res = await fetch(`/api/athletes/${encodeURIComponent(athleteId)}/mvt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lift, velocity }),
      })
      if (!res.ok) throw new Error('Could not save that 1RM velocity')
      setByLift((prev) => {
        const next = { ...prev }
        // A null clears the row rather than storing a zero — "not measured" and
        // "measured as nothing" are different, and only the first falls back.
        if (velocity == null) delete next[lift]
        else next[lift] = velocity
        return next
      })
    },
    [athleteId],
  )

  return { byLift, save }
}
