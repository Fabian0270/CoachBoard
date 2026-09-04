import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, FileVideo, LineChart } from 'lucide-react'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import { pixelsPerMetreFromPlate } from 'coachboard-shared/videoAnalysis'
import {
  defaultMvt,
  e1RMFromVelocity,
  isVbtLift,
  lastRepVelocity,
  liftLabel,
  populationSlope,
  readRep,
  rpeFromLastRepVelocity,
  velocityLoss,
  zoneFor,
  type VbtLift,
} from 'coachboard-shared/vbt'
import { Button } from '../components/ui/button'
import AnalysisStage from '../components/analysis/AnalysisStage'
import PathPlot from '../components/analysis/PathPlot'
import { useTrackerColor } from '../components/analysis/trackerColor'

// ---------------------------------------------------------------------------
// A saved analysis, reopened.
//
// Rebuilt entirely from the stored row — path, calibration, per-rep metrics —
// so it works for a locally imported clip whose video was never uploaded, and
// for a Discord clip whose video has since been purged by retention.
//
// The coach can point it back at the original file if they still have it, which
// replays the path over the footage without the video ever being copied
// anywhere. That keeps the promise the save prompt makes.
// ---------------------------------------------------------------------------

export default function SavedAnalysis() {
  const { id } = useParams()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const emptyLivePath = useRef<never[]>([])
  const [color] = useTrackerColor()

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
  const lift: VbtLift = isVbtLift(analysis.lift) ? analysis.lift : 'other'
  const pixelsPerMetre = analysis.calibration
    ? pixelsPerMetreFromPlate(
        Math.hypot(
          analysis.calibration.b.x - analysis.calibration.a.x,
          analysis.calibration.b.y - analysis.calibration.a.y,
        ),
        analysis.calibration.plateDiameterMm,
      )
    : null

  // Read the same way the live panel does, so one set never shows two numbers.
  const lastV = lastRepVelocity(metrics, 'propulsive')
  const bestV = metrics.length
    ? Math.max(...metrics.map((m) => readRep(m, 'propulsive') ?? 0))
    : 0
  const reading = lastV != null ? rpeFromLastRepVelocity(lift, lastV) : null
  const mvt = defaultMvt(lift)
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

  const videoSrc =
    localUrl ?? (analysis.mediaId ? `/api/discord/media/${analysis.mediaId}/file` : null)

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
        />
      ) : (
        <PathPlot track={analysis.track} color={color} pixelsPerMetre={pixelsPerMetre} />
      )}

      {!analysis.mediaId && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <FileVideo className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            {localUrl
              ? 'Playing your local copy — it is still only on this computer.'
              : 'This came from a file on your computer, which was never uploaded. Pick it again to replay the path over it.'}
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
                  const v = readRep(m, 'propulsive')
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
