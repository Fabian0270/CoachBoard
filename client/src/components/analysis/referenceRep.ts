import { useCallback, useEffect, useState } from 'react'
import { analysisPixelsPerMetre, repDrift, type RepMetrics, type Sample, type VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import { readRep, type VelocityMetric } from 'coachboard-shared/vbt'
import { getJson, sendJson } from '../../lib/api'
import { repWindows } from './pathPaint'

// ---------------------------------------------------------------------------
// The athlete's reference rep for a lift (BP28, D57): one saved rep that every
// new analysis of the lift is drawn against, faintly, from the top of the rep
// being played. In real units only — two clips are rarely filmed at the same
// zoom, so both need a scale.
// ---------------------------------------------------------------------------

export interface ReferencePointer { analysisId: string; repIndex: number }

/** The reference rep's path in metres from the top before it, its rep, and its set. */
export interface ReferenceShape {
  analysis: VideoAnalysisDto
  rep: RepMetrics
  /** Metres from the top before the rep; y down, as in the picture. */
  path: { x: number; y: number }[]
}

export function referenceShape(analysis: VideoAnalysisDto, repIndex: number): ReferenceShape | null {
  const ppm = analysisPixelsPerMetre(analysis)
  const track = analysis.track ?? []
  if (!ppm || track.length < 2) return null
  const sorted = [...analysis.metrics].sort((a, b) => a.startT - b.startT)
  const at = sorted.findIndex((r) => r.index === repIndex)
  if (at < 0) return null
  const w = repWindows(sorted, track[0].t)[at]
  const pts = track.filter((s) => s.t >= w.from && s.t <= w.to)
  if (pts.length < 2) return null
  const o = pts[0]
  return { analysis, rep: sorted[at], path: pts.map((s) => ({ x: (s.x - o.x) / ppm, y: (s.y - o.y) / ppm })) }
}

export interface ReferenceRow {
  label: string
  rangeCm: number | null
  driftCm: number | null
  /** In the set's speed; null when the loads differ (D57) or there is no scale. */
  speed: number | null
}

/**
 * The reference rep and each rep of this set side by side: range and the
 * furthest sideways drift always, speed only at exactly the same load (D57).
 */
export function compareToReference(
  ref: ReferenceShape,
  current: { reps: RepMetrics[]; track: Sample[]; pixelsPerMetre: number | null; loadKg: number | null },
  metric: VelocityMetric,
): { reference: ReferenceRow; reps: ReferenceRow[]; sameLoad: boolean } {
  const refPpm = analysisPixelsPerMetre(ref.analysis)
  const sameLoad = current.loadKg != null && ref.analysis.loadKg != null && Math.abs(current.loadKg - ref.analysis.loadKg) < 1e-6
  const row = (label: string, r: RepMetrics, track: Sample[], ppm: number | null): ReferenceRow => {
    const d = repDrift(track, r, ppm)
    return {
      label,
      rangeCm: r.romM != null ? r.romM * 100 : null,
      driftCm: d?.maxM != null ? d.maxM * 100 : null,
      speed: sameLoad ? readRep(r, metric) : null,
    }
  }
  const sorted = [...current.reps].sort((a, b) => a.startT - b.startT)
  return {
    reference: row('Reference', ref.rep, ref.analysis.track ?? [], refPpm),
    reps: sorted.map((r, i) => row(`Rep ${i + 1}`, r, current.track, current.pixelsPerMetre)),
    sameLoad,
  }
}

/**
 * The athlete's reference for a lift, with its set loaded, and a way to mark
 * or clear one. Nothing without an athlete.
 */
export function useReferenceRep(athleteId: string | null, lift: string | null) {
  const [pointers, setPointers] = useState<Record<string, ReferencePointer>>({})
  const [shape, setShape] = useState<ReferenceShape | null>(null)

  useEffect(() => {
    if (!athleteId) { setPointers({}); return }
    let cancelled = false
    getJson<Record<string, ReferencePointer>>(`/api/athletes/${encodeURIComponent(athleteId)}/reference-reps`)
      .then((p) => !cancelled && setPointers(p))
      // No reference is the ordinary case; a failed read reads the same way.
      .catch(() => !cancelled && setPointers({}))
    return () => { cancelled = true }
  }, [athleteId])

  const pointer = lift ? pointers[lift] ?? null : null
  useEffect(() => {
    if (!pointer) { setShape(null); return }
    let cancelled = false
    getJson<VideoAnalysisDto>(`/api/analysis/${encodeURIComponent(pointer.analysisId)}`)
      .then((a) => !cancelled && setShape(referenceShape(a, pointer.repIndex)))
      .catch(() => !cancelled && setShape(null))
    return () => { cancelled = true }
  }, [pointer?.analysisId, pointer?.repIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  const mark = useCallback(async (analysisId: string | null, repIndex = 0) => {
    if (!athleteId || !lift) return
    setPointers(await sendJson<Record<string, ReferencePointer>>('PUT', `/api/athletes/${encodeURIComponent(athleteId)}/reference-reps`, { lift, analysisId, repIndex }))
  }, [athleteId, lift])

  return { pointer, shape, mark }
}
