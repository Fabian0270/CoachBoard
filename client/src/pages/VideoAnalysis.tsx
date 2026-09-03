import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Crosshair, Loader2, Palette, RotateCcw, Ruler, Target } from 'lucide-react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import { Button } from '../components/ui/button'
import { useToast } from '../components/ui/toast'
import AnalysisStage, {
  type CalibrationLine,
  type SeedPoint,
  type StageMode,
} from '../components/analysis/AnalysisStage'
import VideoPicker, { type AnalysisSource } from '../components/analysis/VideoPicker'
import { useTracker } from '../components/analysis/useTracker'
import { captureFrames } from '../components/analysis/captureFrames'
import type { Sample, TrackQuality } from '../components/analysis/tracker.core'
import { TRACKER_COLORS, useTrackerColor } from '../components/analysis/trackerColor'
import {
  analysePath,
  pixelsPerMetreFromPlate,
  PLATE_DIAMETERS_MM,
  type RepMetrics,
} from 'coachboard-shared/videoAnalysis'

type Phase = 'idle' | 'capturing' | 'tracking' | 'done'

/** Below this the numbers stop meaning anything, so no path is shown at all. */
const MIN_EFFECTIVE_FPS = 20
const MIN_SURVIVAL = 0.4

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function VideoAnalysis() {
  const { mediaId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { status: cvStatus, error: cvError, track } = useTracker()

  const [source, setSource] = useState<AnalysisSource | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const [seed, setSeed] = useState<SeedPoint | null>(null)
  const [samples, setSamples] = useState<Sample[] | null>(null)
  const [quality, setQuality] = useState<TrackQuality | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [color, setColor] = useTrackerColor()
  const [plateMm, setPlateMm] = useState<number>(PLATE_DIAMETERS_MM[0].value)
  const [mode, setMode] = useState<StageMode>('seed')
  const [calibration, setCalibration] = useState<CalibrationLine | null>(null)
  const [awaitingSecondPoint, setAwaitingSecondPoint] = useState(false)

  /**
   * Everything below belongs to ONE video, and React Router keeps this page
   * mounted when the :mediaId param changes rather than remounting it. Without
   * this reset the previous video's analysis bleeds into the next one — open a
   * second clip from the inbox and you would see the first clip's bar path
   * drawn over it, with its calibration and rep numbers still on screen.
   */
  useEffect(() => {
    setSeed(null)
    setSamples(null)
    setQuality(null)
    setPhase('idle')
    setCalibration(null)
    setAwaitingSecondPoint(false)
    setMode('seed')
    setRange(null)
    setDuration(0)
    setCurrentTime(0)
    setNotFound(false)
    // Leaving the deep link entirely (back to /analysis) means no video at all,
    // so the picker takes over. A locally-imported file has no id and must
    // survive this, hence only clearing when the param is genuinely absent.
    if (!mediaId) setSource(null)
  }, [mediaId])

  // Deep-linked from a video's player dialog: resolve that one and skip the picker.
  useEffect(() => {
    if (!mediaId) return
    let cancelled = false
    fetch(`/api/discord/media/${mediaId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((data: DiscordMediaItem) => !cancelled && setSource({ kind: 'discord', item: data }))
      .catch(() => !cancelled && setNotFound(true))
    return () => {
      cancelled = true
    }
  }, [mediaId])

  // A local file is held as an object URL for as long as it is being analysed.
  // Revoked on swap or unmount, or the bytes stay pinned in memory for the life
  // of the window.
  useEffect(() => {
    if (source?.kind !== 'local') return
    const url = source.url
    return () => URL.revokeObjectURL(url)
  }, [source])

  const videoSrc =
    source?.kind === 'local'
      ? source.url
      : source?.kind === 'discord'
        ? `/api/discord/media/${source.item.id}/file`
        : null

  const sourceLabel =
    source?.kind === 'local'
      ? source.name
      : source?.kind === 'discord'
        ? `${source.item.athleteName ?? source.item.authorUsername} · ${source.item.postedAt.slice(0, 10)}`
        : ''

  const onLoadedMetadata = (video: HTMLVideoElement) => {
    setDuration(video.duration)
    // Default to the whole clip; the coach narrows it to the rep itself, which
    // both speeds tracking up and keeps it off footage with no bar in it.
    setRange((r) => r ?? { from: 0, to: video.duration })
    // A plate is a decent fraction of the frame, so this lands close on most
    // clips and the coach nudges it rather than starting from nothing.
    setSeed((s) => s ?? null)
  }

  const placeSeed = (point: { x: number; y: number }) => {
    const video = videoRef.current
    if (!video) return
    setSeed((prev) => ({
      x: point.x,
      y: point.y,
      radius: prev?.radius ?? Math.max(24, Math.round(video.videoWidth * 0.07)),
    }))
    // Any previous path belongs to the old point.
    setSamples(null)
    setQuality(null)
    setPhase('idle')
  }

  /**
   * Two clicks define the scale line: the first drops one end, the second
   * completes it and returns to placing the tracking point.
   */
  const addCalibrationPoint = (point: { x: number; y: number }) => {
    if (awaitingSecondPoint) {
      setCalibration((prev) => (prev ? { a: prev.a, b: point } : { a: point, b: point }))
      setAwaitingSecondPoint(false)
      setMode('seed')
    } else {
      setCalibration({ a: point, b: point })
      setAwaitingSecondPoint(true)
    }
  }

  const resizeSeed = (delta: number) => {
    const video = videoRef.current
    if (!video) return
    setSeed((s) =>
      s ? { ...s, radius: Math.min(video.videoWidth / 2, Math.max(12, s.radius + delta)) } : s,
    )
  }

  const runTracking = async () => {
    const video = videoRef.current
    if (!video || !seed || !range) return

    setPhase('capturing')
    setProgress(0)
    setSamples(null)
    setQuality(null)

    try {
      const { frames, scale } = await captureFrames(video, {
        from: range.from,
        to: range.to,
        onProgress: setProgress,
      })
      if (frames.length < 5) {
        toast.error('Not enough frames in that range — widen it and try again.')
        setPhase('idle')
        return
      }

      setPhase('tracking')
      const result = await track(frames, {
        x: (seed.x - seed.radius) * scale,
        y: (seed.y - seed.radius) * scale,
        width: seed.radius * 2 * scale,
        height: seed.radius * 2 * scale,
      })

      const q = result.quality
      if (q.effectiveFps < MIN_EFFECTIVE_FPS || q.medianSurvivalRate < MIN_SURVIVAL) {
        // Deliberately show nothing rather than a path we do not trust — a
        // wrong number costs more credibility than an absent one.
        setQuality(q)
        setPhase('idle')
        toast.error(
          'That track was too unreliable to use. Try clicking nearer the middle of a plate, or enlarging the search circle with +.',
        )
        return
      }

      // Back to original video pixels so the overlay lines up with the frame.
      setSamples(result.samples.map((s) => ({ t: s.t, x: s.x / scale, y: s.y / scale })))
      setQuality(q)
      setPhase('done')
      video.currentTime = range.from
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Tracking failed')
      setPhase('idle')
    }
  }

  const reset = () => {
    setSeed(null)
    setSamples(null)
    setQuality(null)
    setPhase('idle')
    setCalibration(null)
    setAwaitingSecondPoint(false)
    setMode('seed')
  }

  /** Back to the picker. Everything is per-video, so none of it may carry over. */
  const chooseAnother = () => {
    reset()
    setRange(null)
    setDuration(0)
    setCurrentTime(0)
    setSource(null)
    setNotFound(false)
    if (mediaId) navigate('/analysis', { replace: true })
  }

  if (notFound) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">That video no longer exists.</p>
        <Button variant="outline" className="mt-4" onClick={chooseAnother}>
          Choose another video
        </Button>
      </div>
    )
  }

  // No video chosen yet — this is the page's own landing state, not an error.
  if (!source) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-lg font-semibold">Bar path analysis</h1>
          <p className="text-sm text-muted-foreground">
            Track the bar through a lift to see its path and per-rep velocity.
          </p>
        </div>
        {mediaId ? (
          <p className="text-sm text-muted-foreground">Loading video…</p>
        ) : (
          <VideoPicker onPick={setSource} />
        )}
      </div>
    )
  }

  const busy = phase === 'capturing' || phase === 'tracking'
  const canTrack = !!seed && cvStatus === 'ready' && !busy && !!range

  // Scale comes from a line the coach drags across a plate of known diameter.
  // The plate is the reference because it sits IN the plane the bar travels in,
  // so it distorts less than anything else in frame. Velocity stays in px/s
  // until that line exists: an uncalibrated m/s would be a confidently wrong
  // number, which is worse than an honest pixel one.
  const calibrationPx = calibration
    ? Math.hypot(calibration.b.x - calibration.a.x, calibration.b.y - calibration.a.y)
    : 0
  const pixelsPerMetre =
    calibrationPx > 1 ? pixelsPerMetreFromPlate(calibrationPx, plateMm) : null
  const reps: RepMetrics[] = samples ? analysePath(samples, pixelsPerMetre).reps : []

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={chooseAnother} title="Choose another video">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Bar path analysis</h1>
          <p className="truncate text-sm text-muted-foreground">{sourceLabel}</p>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={chooseAnother} disabled={busy}>
          Choose another video
        </Button>
      </div>

      {videoSrc && (
        <AnalysisStage
          src={videoSrc}
          videoRef={videoRef}
          seed={seed}
          samples={samples}
          onPlaceSeed={placeSeed}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={setCurrentTime}
          disabled={busy}
          color={color}
          mode={mode}
          calibration={calibration}
          onCalibratePoint={addCalibrationPoint}
        />
      )}

      <div className="rounded-md border p-4">
        {cvStatus === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparing the analyser…
          </p>
        )}
        {cvStatus === 'error' && (
          <p className="text-sm text-destructive">Could not load the analyser: {cvError}</p>
        )}

        {cvStatus === 'ready' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-2 text-sm">
                <Crosshair className="h-4 w-4 text-muted-foreground" />
                {mode === 'calibrate'
                  ? 'Click both edges of a plate to set the scale'
                  : samples
                    ? 'Tracked — play the clip to watch the dot follow the bar'
                    : seed
                      ? 'Point set — the circle is the search area, then track'
                      : 'Click the middle of a plate to place the tracking point'}
              </span>
              {seed && (
                <>
                  <Button size="sm" variant="outline" onClick={() => resizeSeed(-8)} disabled={busy}>
                    −
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => resizeSeed(8)} disabled={busy}>
                    +
                  </Button>
                </>
              )}

              <span className="ml-auto flex items-center gap-1.5">
                <Palette className="h-4 w-4 text-muted-foreground" />
                {TRACKER_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.name}
                    aria-label={`${c.name} overlay`}
                    aria-pressed={color === c.value}
                    onClick={() => setColor(c.value)}
                    className={`h-5 w-5 rounded-full border transition-transform ${
                      color === c.value
                        ? 'scale-110 border-foreground ring-2 ring-foreground/30'
                        : 'border-border hover:scale-110'
                    }`}
                    style={{ backgroundColor: c.value }}
                  />
                ))}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Track from</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setRange((r) => ({ from: currentTime, to: Math.max(currentTime + 0.2, r?.to ?? duration) }))}
              >
                Set start ({fmt(range?.from ?? 0)})
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setRange((r) => ({ from: Math.min(r?.from ?? 0, currentTime - 0.2), to: currentTime }))}
              >
                Set end ({fmt(range?.to ?? duration)})
              </Button>

            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Ruler className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Scale</span>
              <select
                value={plateMm}
                onChange={(e) => setPlateMm(Number(e.target.value))}
                disabled={busy}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              >
                {PLATE_DIAMETERS_MM.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant={mode === 'calibrate' ? 'default' : 'outline'}
                disabled={busy}
                onClick={() => {
                  setMode((m) => (m === 'calibrate' ? 'seed' : 'calibrate'))
                  setAwaitingSecondPoint(false)
                }}
              >
                {mode === 'calibrate'
                  ? awaitingSecondPoint
                    ? 'Now click the far edge'
                    : 'Click one edge of the plate'
                  : pixelsPerMetre
                    ? 'Redo scale'
                    : 'Set scale'}
              </Button>
              {pixelsPerMetre ? (
                <span className="text-muted-foreground">
                  {Math.round(calibrationPx)} px across a {plateMm} mm plate — velocity in m/s
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Not set — velocity will be in pixels/second
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runTracking} disabled={!canTrack}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
                {phase === 'capturing'
                  ? `Reading frames… ${Math.round(progress * 100)}%`
                  : phase === 'tracking'
                    ? 'Tracking…'
                    : 'Track bar path'}
              </Button>
              {(seed || samples) && (
                <Button variant="ghost" onClick={reset} disabled={busy}>
                  <RotateCcw className="h-4 w-4" /> Clear
                </Button>
              )}
            </div>

            {phase === 'capturing' && (
              <p className="text-xs text-muted-foreground">
                Frames are read while the clip plays, so this takes about as long as the range itself.
              </p>
            )}

            {quality && (
              <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Stat label="Points followed" value={`${quality.seededPoints}`} />
                <Stat label="Kept per frame" value={`${Math.round(quality.medianSurvivalRate * 100)}%`} />
                <Stat label="Re-locks" value={`${quality.reseeds}`} />
                <Stat
                  label="Held for"
                  value={quality.lostAtFrame === null ? 'the whole range' : `${quality.lostAtFrame} frames`}
                />
                <Stat label="Effective frame rate" value={`${quality.effectiveFps.toFixed(1)} fps`} />
                {samples && <Stat label="Path points" value={`${samples.length}`} />}
              </div>
            )}

            {samples && reps.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-medium">
                  Concentric velocity — {reps.length} {reps.length === 1 ? 'rep' : 'reps'}
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[30rem] text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1 pr-4 font-medium">Rep</th>
                        <th className="py-1 pr-4 font-medium">Mean</th>
                        <th className="py-1 pr-4 font-medium">Peak</th>
                        <th className="py-1 pr-4 font-medium">Range</th>
                        <th className="py-1 font-medium">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reps.map((r) => (
                        <tr key={r.index} className="border-b last:border-0">
                          <td className="py-1 pr-4">{r.index + 1}</td>
                          <td className="py-1 pr-4 font-medium">
                            {r.meanVelocity !== null
                              ? `${r.meanVelocity.toFixed(2)} m/s`
                              : `${Math.round(r.meanVelocityPxS)} px/s`}
                          </td>
                          <td className="py-1 pr-4">
                            {r.peakVelocity !== null
                              ? `${r.peakVelocity.toFixed(2)} m/s`
                              : `${Math.round(r.peakVelocityPxS)} px/s`}
                          </td>
                          <td className="py-1 pr-4">
                            {r.romM !== null ? `${(r.romM * 100).toFixed(0)} cm` : `${Math.round(r.romPx)} px`}
                          </td>
                          <td className="py-1">{(r.durationMs / 1000).toFixed(2)} s</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {reps.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    Velocity loss across the set:{' '}
                    <span className="font-medium text-foreground">
                      {(() => {
                        const speeds = reps.map((r) => r.meanVelocity ?? r.meanVelocityPxS)
                        const best = Math.max(...speeds)
                        const last = speeds[speeds.length - 1]
                        return best > 0 ? `${Math.round((1 - last / best) * 100)}%` : '—'
                      })()}
                    </span>{' '}
                    from the fastest rep to the last.
                  </p>
                )}
              </div>
            )}

            {samples && reps.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No complete rep was detected in this range — the bar needs to travel down and back up
                for velocity to mean anything. Try widening the start and end points.
              </p>
            )}

            {samples && (
              <p className="text-xs text-muted-foreground">
                Play the clip and the dot follows the bar. Check the path sits on the plate before
                trusting anything measured from it — these are approximations from a single camera, and
                assume the plate is side-on to it.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
