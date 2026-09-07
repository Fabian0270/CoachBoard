import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, FileVideo, LineChart, PersonStanding } from 'lucide-react'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import { pixelsPerMetreFromPlate } from 'coachboard-shared/videoAnalysis'
import {
  defaultVelocityMetric,
  e1RMFromVelocity,
  isVbtLift,
  isVelocityMetric,
  lastRepVelocity,
  liftLabel,
  populationSlope,
  readRep,
  resolveMvt,
  rpeFromLastRepVelocity,
  velocityLoss,
  zoneFor,
  type VbtLift,
} from 'coachboard-shared/vbt'
import {
  applyCorrections,
  anglesAgainstBar,
  frameAngles,
  type PoseFrame,
} from 'coachboard-shared/pose'
import { analysePath } from 'coachboard-shared/videoAnalysis'
import { Button } from '../components/ui/button'
import { useToast } from '../components/ui/toast'
import AnalysisStage from '../components/analysis/AnalysisStage'
import PathPlot from '../components/analysis/PathPlot'
import JointAngleChart from '../components/analysis/JointAngleChart'
import { loadPose, putCorrection, type LoadedPose } from '../components/analysis/poseApi'
import { useTrackerColor } from '../components/analysis/trackerColor'
import { useAthleteMvt, useVbtHistory } from '../components/analysis/useVbtHistory'

// ---------------------------------------------------------------------------
// A saved analysis, reopened.
//
// Everything a coach reads here is rebuilt from the stored row — path,
// calibration, per-rep metrics — so the analysis survives whatever happened to
// the footage. Saving now keeps the video as well, so the usual case replays it
// straight away; the re-pick input below is what rescues the rows saved before
// that, and any whose file has since gone missing.
// ---------------------------------------------------------------------------

/** Pixels per metre for a saved analysis, or null when it was never calibrated. */
function analysisPixelsPerMetre(analysis: VideoAnalysisDto): number | null {
  if (!analysis.calibration) return null
  return pixelsPerMetreFromPlate(
    Math.hypot(
      analysis.calibration.b.x - analysis.calibration.a.x,
      analysis.calibration.b.y - analysis.calibration.a.y,
    ),
    analysis.calibration.plateDiameterMm,
  )
}

export default function SavedAnalysis() {
  const { id } = useParams()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const emptyLivePath = useRef<never[]>([])
  const [color] = useTrackerColor()
  const toast = useToast()

  const [analysis, setAnalysis] = useState<VideoAnalysisDto | null>(null)
  const [missing, setMissing] = useState(false)
  /** A file the coach re-picked, held as an object URL and never uploaded. */
  const [localUrl, setLocalUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    fetch(`/api/analysis/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((data: VideoAnalysisDto) => !cancelled && setAnalysis(data))
      .catch(() => !cancelled && setMissing(true))
    return () => {
      cancelled = true
    }
  }, [id])

  // Revoked on swap or unmount, or the bytes stay pinned for the life of the window.
  useEffect(() => {
    if (!localUrl) return
    return () => URL.revokeObjectURL(localUrl)
  }, [localUrl])

  // Read the way the set was ACTUALLY read when it was tracked, falling back to
  // the lift's default for rows saved before the metric was stored. This used
  // to be hardcoded to 'propulsive' under a comment claiming it matched the
  // live panel — which stopped being true when the default became mean/peak, so
  // the same bench set reported two different numbers on two pages.
  const lift: VbtLift = isVbtLift(analysis?.lift) ? analysis.lift : 'other'
  const metric = isVelocityMetric(analysis?.metric) ? analysis.metric : defaultVelocityMetric(lift)

  // Resolved above the early returns because hooks cannot run after one. This
  // page was reading the published 0.25 m/s while the live panel read the
  // athlete's own, so the same set reported two different estimated maxes
  // depending on which page you were standing on.
  const athleteId = analysis?.athleteId ?? null
  const { anchors } = useVbtHistory(athleteId, lift, metric)
  const { byLift: mvtByLift } = useAthleteMvt(athleteId)

  /**
   * The stored skeleton, if this analysis has one.
   *
   * Fetched separately from the analysis, and only here — it is ~238 KB and the
   * list view has no use for it, the same reasoning that keeps tracked paths out
   * of list responses.
   *
   * `measured` and `corrections` are kept apart so a fix can be taken back
   * without re-fetching, and so nothing ever writes an edit over the
   * measurement. `poseRef` is what the overlay draws, and is a ref for the same
   * reason it is on the live page.
   */
  const [pose, setPose] = useState<LoadedPose | null>(null)
  const poseRef = useRef<PoseFrame[]>([])
  const [showPose, setShowPose] = useState(true)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    loadPose(id)
      .then((loaded) => {
        if (cancelled) return
        setPose(loaded)
        poseRef.current = loaded?.frames ?? []
      })
      // No skeleton is the ordinary case, and a failed fetch reads the same way:
      // the bar path is what this page is for.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id])

  /**
   * Moves one landmark and keeps it.
   *
   * Applied locally first so the drag lands immediately, then persisted. The
   * correction is layered over `measured` rather than written into it — the
   * measurement stays exactly what the model produced.
   */
  const correctLandmark = useCallback(
    async (frameIndex: number, landmark: number, x: number, y: number) => {
      if (!id) return
      setPose((prev) => {
        if (!prev) return prev
        const corrections = [
          ...prev.corrections.filter(
            (c) => c.frameIndex !== frameIndex || c.landmark !== landmark,
          ),
          { frameIndex, landmark, x, y },
        ]
        const next = { ...prev, corrections, frames: applyCorrections(prev.measured, corrections) }
        poseRef.current = next.frames
        return next
      })
      try {
        await putCorrection(id, { frameIndex, landmark, x, y })
      } catch {
        toast.error('That correction could not be saved.')
      }
    },
    [id, toast],
  )

  /**
   * Joint angles beside the bar's own speed, on one time axis.
   *
   * Computed above the early returns because hooks cannot run after one, and
   * derived rather than stored — angles are a function of the landmarks plus the
   * corrections, like payment_end and unlike the cached per-rep metrics. Storing
   * them would mean a coach's correction could leave a stale number behind.
   */
  const poseSeries = useMemo(() => {
    if (!analysis || !pose || pose.frames.length === 0) return null
    const scale = analysisPixelsPerMetre(analysis)
    const { velocities } = analysePath(analysis.track ?? [], scale)
    // verticalVelocity works in pixels; convert once here so the chart's axis
    // and its unit label cannot disagree.
    const inUnits = scale
      ? velocities.map((v) => ({ t: v.t, vy: v.vy / scale }))
      : velocities.map((v) => ({ t: v.t, vy: v.vy }))
    return anglesAgainstBar(frameAngles(pose.frames), inUnits)
  }, [analysis, pose])

  if (missing) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">That analysis no longer exists.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/analysis')}>
          Back to bar path
        </Button>
      </div>
    )
  }
  if (!analysis) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>

  const metrics = analysis.metrics ?? []
  // `lift` is declared above the early returns now — the pose hooks need it, and
  // hooks cannot run after a conditional return.
  const pixelsPerMetre = analysisPixelsPerMetre(analysis)

  const lastV = lastRepVelocity(metrics, metric)
  const bestV = metrics.length ? Math.max(...metrics.map((m) => readRep(m, metric) ?? 0)) : 0
  // Judged against this athlete's own history, not the published chart — the
  // live panel does the same, and two pages disagreeing about one rep's RPE is
  // worse than either answer on its own.
  const reading = lastV != null ? rpeFromLastRepVelocity(lift, lastV, { anchors }) : null
  const mvt = resolveMvt(lift, { stored: mvtByLift[lift], anchors })
  const estimate =
    analysis.loadKg != null && bestV > 0 && mvt != null
      ? e1RMFromVelocity({
          loadKg: analysis.loadKg,
          velocity: bestV,
          mvt,
          slope: populationSlope(lift),
        })
      : null
  const loss = velocityLoss(metrics)

  // One route for both kinds of ownership — a stored copy of a local import, or
  // the synced Discord file it references. The page does not need to know which.
  // localUrl still wins, for an analysis saved before videos were kept.
  const videoSrc = localUrl ?? (analysis.hasVideo ? `/api/analysis/${analysis.id}/video` : null)

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/analysis')} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">
            {isVbtLift(analysis.lift) ? liftLabel(lift) : 'Bar path analysis'}
            {analysis.loadKg != null && ` — ${analysis.loadKg} kg`}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            {analysis.athleteName ?? 'Unassigned'} · {analysis.createdAt.slice(0, 10)} ·{' '}
            {analysis.sourceLabel || 'no source name'}
          </p>
        </div>
        {analysis.mediaId && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => navigate(`/analysis/${analysis.mediaId}`)}
          >
            <LineChart className="h-4 w-4" /> Track this clip again
          </Button>
        )}
      </div>

      {/* The path is always available; the video is a bonus when the coach still
          has the file. Nothing was stored to make this work. */}
      {videoSrc ? (
        <AnalysisStage
          src={videoSrc}
          videoRef={videoRef}
          seed={null}
          samples={analysis.track}
          livePathRef={emptyLivePath}
          onPlaceSeed={() => {}}
          onLoadedMetadata={() => {}}
          onTimeUpdate={() => {}}
          disabled
          color={color}
          mode="seed"
          calibration={analysis.calibration}
          onCalibratePoint={() => {}}
          poseRef={poseRef}
          showPose={showPose}
          onCorrectLandmark={correctLandmark}
        />
      ) : (
        <PathPlot track={analysis.track} color={color} pixelsPerMetre={pixelsPerMetre} />
      )}

      {/* Only offered when there is a skeleton to show. A checkbox for something
          this analysis does not have would just be a dead control. */}
      {pose && pose.frames.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showPose}
              onChange={(e) => setShowPose(e.target.checked)}
              className="h-3.5 w-3.5 accent-cyan-400"
            />
            <PersonStanding className="h-4 w-4 text-muted-foreground" />
            Skeleton
          </label>
          {showPose && videoSrc && (
            <span className="text-xs text-muted-foreground">
              Drag a joint to correct it — the model&rsquo;s own reading is kept underneath.
            </span>
          )}
          {pose.corrections.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {pose.corrections.length} correction{pose.corrections.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      {/* The coaching payoff: what the body was doing when the bar stalled.
          Both series already share a clock and a coordinate space, so there is
          no alignment step — see anglesAgainstBar. */}
      {poseSeries && poseSeries.length > 1 && (
        <div className="space-y-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">Joint angles against the bar</h2>
          <JointAngleChart series={poseSeries} calibrated={pixelsPerMetre !== null} />
        </div>
      )}

      {/* Only when nothing plays. Analyses saved before videos were kept have no
          stored copy, and a Discord clip can still be missing if its file was
          removed outside the app — either way the path survives and the coach
          can point this back at their own file. */}
      {!analysis.hasVideo && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <FileVideo className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            {localUrl
              ? 'Playing your local copy — it is still only on this computer.'
              : 'This analysis was saved before videos were kept. Pick the file again to replay the path over it.'}
          </span>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) setLocalUrl(URL.createObjectURL(file))
            }}
            className="text-xs file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-xs"
          />
        </label>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <h2 className="text-sm font-medium">
            Concentric velocity — {metrics.length} {metrics.length === 1 ? 'rep' : 'reps'}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 pr-4 font-medium">Rep</th>
                  <th className="py-1 pr-4 font-medium">Propulsive</th>
                  <th className="py-1 pr-4 font-medium">Mean</th>
                  <th className="py-1 pr-4 font-medium">Range</th>
                  <th className="py-1 font-medium">≈ RPE</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => {
                  const v = readRep(m, metric)
                  const rpe = v != null ? rpeFromLastRepVelocity(lift, v) : null
                  return (
                    <tr key={m.index} className="border-b last:border-0">
                      <td className="py-1 pr-4">{m.index + 1}</td>
                      <td className="py-1 pr-4 font-medium">
                        {v != null ? `${v.toFixed(2)} m/s` : '—'}
                      </td>
                      <td className="py-1 pr-4">
                        {m.meanVelocity != null ? `${m.meanVelocity.toFixed(2)} m/s` : '—'}
                      </td>
                      <td className="py-1 pr-4">
                        {m.romM != null
                          ? `${(m.romM * 100).toFixed(0)} cm`
                          : `${Math.round(m.romPx)} px`}
                      </td>
                      <td className="py-1">{rpe ? rpe.rpe : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-1 text-sm">
          <h2 className="mb-2 text-sm font-medium">Velocity-based readouts</h2>
          <Row label="Lift" value={isVbtLift(analysis.lift) ? liftLabel(lift) : 'not recorded'} />
          <Row
            label="Load"
            value={analysis.loadKg != null ? `${analysis.loadKg} kg` : 'not recorded'}
          />
          <Row label="RPE called" value={analysis.calledRpe != null ? `${analysis.calledRpe}` : '—'} />
          <Row
            label="Last rep"
            value={lastV != null ? `${lastV.toFixed(2)} m/s` : 'no scale was set'}
          />
          <Row label="Reads as" value={reading ? `RPE ${reading.rpe}` : '—'} />
          <Row
            label="Velocity loss"
            value={loss ? `${Math.round(loss.lossPct)}%${loss.reliable ? '' : ' (few reps)'}` : '—'}
          />
          <Row
            label="Estimated 1RM"
            value={estimate ? `${Math.round(estimate.e1rm * 2) / 2} kg` : '—'}
          />
          <Row label="Quality" value={lastV != null ? (zoneFor(lastV)?.label ?? '—') : '—'} />
          <p className="pt-2 text-xs text-muted-foreground">
            Read off the published reference for this lift. The live panel personalises these from
            the athlete&rsquo;s own sets; this view shows what was measured.
          </p>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
