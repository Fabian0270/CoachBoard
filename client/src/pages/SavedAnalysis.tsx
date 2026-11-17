import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, FileVideo, LineChart, Pencil, PersonStanding } from 'lucide-react'
import { RPE_VALUES } from 'coachboard-shared/rpe'
import { num } from '../lib/num'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import { pixelsPerMetreFromPlate } from 'coachboard-shared/videoAnalysis'
import {
  VBT_LIFTS,
  defaultVelocityMetric,
  effectiveRpe,
  isVbtLift,
  isVelocityMetric,
  lastRepVelocity,
  liftLabel,
  zoneFor,
  type VbtLift,
} from 'coachboard-shared/vbt'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'
import { applyCorrections, type PoseFrame } from 'coachboard-shared/pose'
import { Button } from '../components/ui/button'
import { useToast } from '../components/ui/toast'
import AnalysisStage, { repWindows, type StageMode } from '../components/analysis/AnalysisStage'
import DrawControls from '../components/analysis/DrawControls'
import type { Stroke } from '../components/analysis/annotations'
import RepTable from '../components/analysis/RepTable'
import { readSet } from '../components/analysis/readSet'
import { plainKey, useAnalysisKeys } from '../components/analysis/analysisKeys'
import LoadError from '../components/LoadError'
import { ApiError, errorMessage, getJson, sendJson } from '../lib/api'
import PathPlot from '../components/analysis/PathPlot'
import JointAngleChart, { angleSeries } from '../components/analysis/JointAngleChart'
import BarSpeedChart from '../components/analysis/BarSpeedChart'
import { loadPose, putCorrection, type LoadedPose } from '../components/analysis/poseApi'
import { useTrackerColor } from '../components/analysis/trackerColor'
import { useAthleteMaxes, useAthleteMvt, useVbtHistory } from '../components/analysis/useVbtHistory'

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
  /** A load that failed for another reason than the analysis being gone. */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  /** A file the coach re-picked, held as an object URL and never uploaded. */
  const [localUrl, setLocalUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoadError(null)
    // Only a 404 is "no longer exists". Any other failure used to say the same,
    // which told a coach their saved work was gone when the read had only failed.
    getJson<VideoAnalysisDto>(`/api/analysis/${encodeURIComponent(id)}`)
      .then((data) => !cancelled && setAnalysis(data))
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) setMissing(true)
        else setLoadError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [id, attempt])

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
  // The athlete's OTHER sets: this one is added below exactly as the live page
  // adds the set it is tracking, so both pages read it against the same history.
  const { anchors: otherAnchors, points: savedPoints } = useVbtHistory(athleteId, lift, metric, id ?? null)
  const { byLift: mvtByLift } = useAthleteMvt(athleteId)
  const maxes = useAthleteMaxes(athleteId)

  // The pen (BP7). The stage's own comments name this page as where a coach
  // talks over a lift, and it had no pen; Compare did.
  const [mode, setMode] = useState<StageMode>('seed')
  const [strokes, setStrokes] = useState<Stroke[]>([])
  /** The playhead, so the path plot beside the video picks out the rep on screen. */
  const [currentTime, setCurrentTime] = useState(0)
  // P picks up and puts down the pen (BP15), wherever a video plays.
  useAnalysisKeys(!!(localUrl || analysis?.hasVideo), (e) => {
    if (!plainKey(e, 'p')) return false
    setMode((m) => (m === 'draw' ? 'seed' : 'draw'))
    return true
  })

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

  /** Joint angles beside the bar's speed. Above the early returns: hooks cannot run after one. */
  const poseSeries = useMemo(() => {
    if (!analysis || !pose || pose.frames.length === 0) return null
    return angleSeries(pose.frames, analysis.track ?? [], analysisPixelsPerMetre(analysis))
  }, [analysis, pose])

  /**
   * Correcting what the set was — lift, load, called RPE — after it was saved.
   * The path and per-rep metrics stay as tracked; only the context changes.
   */
  const [editing, setEditing] = useState(false)
  const [savingContext, setSavingContext] = useState(false)
  const startEditing = () => setEditing(true)
  const saveContext = async (change: { lift: string | null; loadKg: number | null; calledRpe: number | null; notes: string | null }) => {
    if (!analysis) return
    setSavingContext(true)
    try {
      const res = await fetch(`/api/analysis/${analysis.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // A changed lift resets the metric to that lift's default, the same
        // rule the live panel follows.
        body: JSON.stringify({ ...change, ...(change.lift !== analysis.lift ? { metric: null } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `the server said ${res.status}`)
      setAnalysis(body as VideoAnalysisDto)
      setEditing(false)
      toast.success('Set updated')
    } catch (err) {
      toast.error(`Could not update the set — ${err instanceof Error ? err.message : 'unknown error'}.`)
    } finally {
      setSavingContext(false)
    }
  }

  /**
   * Strike a rep off the saved set (BP4): at once, with Undo (D38). It changes
   * the stored set, and with it the athlete's profile and estimates, the same
   * as striking it before saving would have.
   */
  const storeReps = async (next: RepMetrics[]): Promise<boolean> => {
    if (!analysis) return false
    try {
      setAnalysis(await sendJson<VideoAnalysisDto>('PATCH', `/api/analysis/${analysis.id}`, { metrics: next }))
      return true
    } catch (err) {
      toast.error(`Could not change the reps. ${errorMessage(err)} Nothing was changed.`)
      return false
    }
  }
  const strikeRep = async (index: number) => {
    if (!analysis) return
    const before = analysis.metrics ?? []
    if (!(await storeReps(before.filter((r) => r.index !== index)))) return
    toast.info(`Rep ${index + 1} struck off`, {
      action: { label: 'Undo', onClick: () => void storeReps(before) },
      duration: 8000,
    })
  }

  if (loadError) return <div className="p-6"><LoadError what="this analysis" message={loadError} onRetry={() => setAttempt((n) => n + 1)} /></div>
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

  const calibrated = analysis.calibration !== null
  // The top before each rep: 1–9 and a click on a rep's number go there.
  const repTops = analysis.track?.length && metrics.length ? repWindows(metrics, analysis.track[0].t).map((w) => w.from) : []
  // This set's own anchor, added to the athlete's others the way the live page
  // adds the set it is tracking.
  const ownLastV = calibrated ? lastRepVelocity(metrics, metric) : null
  const anchors = analysis.calledRpe != null && ownLastV != null
    ? [...otherAnchors, { rpe: analysis.calledRpe, velocity: ownLastV }]
    : otherAnchors
  // Every reading from the same function as the live panel (BP3): the same set
  // gives the same RPE and the same estimated max on both pages.
  const { lastV, reading, loss, estimate } = readSet({
    reps: metrics, lift, metric, calibrated, loadKg: analysis.loadKg, calledRpe: analysis.calledRpe,
    anchors, storedMvt: mvtByLift[lift] ?? null, savedPoints, maxes,
  })

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
        {/* The same pen as the tracking page and Compare (BP7), wherever a video plays. */}
        {videoSrc && (
          <div className="ml-auto">
            <DrawControls mode={mode} onModeChange={setMode} strokes={strokes} onStrokesChange={setStrokes} />
          </div>
        )}
        {analysis.mediaId && (
          <Button
            variant="outline"
            size="sm"
            className={videoSrc ? '' : 'ml-auto'}
            onClick={() => navigate(`/analysis/${analysis.mediaId}`)}
          >
            <LineChart className="h-4 w-4" /> Track this clip again
          </Button>
        )}
      </div>

      {/* The coach's note on the set (BP23); changed under "Edit set". */}
      {analysis.notes && (
        <p className="max-w-3xl whitespace-pre-wrap rounded-md border-l-2 border-primary/60 bg-primary/5 px-3 py-2 text-sm">
          {analysis.notes}
        </p>
      )}

      {/* The path is always available; the video is a bonus when the coach still
          has the file. Nothing was stored to make this work. */}
      {videoSrc ? (
        // The reps laid over each other beside the video (BP10). It used to
        // appear only when there was no video.
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <AnalysisStage
          src={videoSrc}
          videoRef={videoRef}
          seed={null}
          samples={analysis.track}
          livePathRef={emptyLivePath}
          onPlaceSeed={() => {}}
          onLoadedMetadata={() => {}}
          onTimeUpdate={setCurrentTime}
          disabled
          color={color}
          mode={mode}
          calibration={analysis.calibration}
          onCalibratePoint={() => {}}
          poseRef={poseRef}
          showPose={showPose}
          onCorrectLandmark={correctLandmark}
          strokes={strokes}
          onDrawStroke={(s) => setStrokes((prev) => [...prev, s])}
          keyboard
          repStarts={repTops}
          reps={metrics}
        />
        <PathPlot track={analysis.track} color={color} pixelsPerMetre={pixelsPerMetre} reps={metrics} currentTime={currentTime} height={320} />
        </div>
      ) : (
        <PathPlot track={analysis.track} color={color} pixelsPerMetre={pixelsPerMetre} reps={metrics} />
      )}

      {/* The bar's speed through the set and each rep's sticking point (BP11),
          with or without a skeleton. */}
      {analysis.track && analysis.track.length > 1 && (
        <div className="space-y-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">Bar speed</h2>
          <BarSpeedChart track={analysis.track} reps={metrics} pixelsPerMetre={pixelsPerMetre} currentTime={videoSrc ? currentTime : undefined} />
        </div>
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
          {/* The live page's table (BP1, BP2, BP4): every speed, the one the set
              is read from marked, the ⚠ flag, and a rep can be struck off — at
              once, with Undo. The last rep stays: a set needs one. */}
          <RepTable
            reps={metrics}
            lift={lift}
            metric={metric}
            calibrated={calibrated}
            anchors={anchors}
            track={analysis.track}
            pixelsPerMetre={pixelsPerMetre}
            onToggle={metrics.length > 1 ? (index) => void strikeRep(index) : undefined}
            onJump={videoSrc ? (index) => {
              const at = repTops[metrics.findIndex((r) => r.index === index)]
              const v = videoRef.current
              if (at == null || !v) return
              v.pause()
              v.currentTime = at
            } : undefined}
          />
        </div>

        <div className="space-y-1 text-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Velocity-based readouts</h2>
            {!editing && (
              <Button size="sm" variant="ghost" onClick={startEditing}>
                <Pencil className="h-3.5 w-3.5" /> Edit set
              </Button>
            )}
          </div>
          {editing ? (
            <SetContextEditor
              initial={{ lift: analysis.lift, loadKg: analysis.loadKg, calledRpe: analysis.calledRpe, notes: analysis.notes }}
              saving={savingContext}
              onCancel={() => setEditing(false)}
              onSave={saveContext}
            />
          ) : (
            <>
              <Row label="Lift" value={isVbtLift(analysis.lift) ? liftLabel(lift) : 'not recorded'} />
              <Row
                label="Load"
                value={analysis.loadKg != null ? `${analysis.loadKg} kg` : 'not recorded'}
              />
              <Row label="RPE called" value={analysis.calledRpe != null ? `${analysis.calledRpe}` : '—'} />
            </>
          )}
          <Row
            label="Last rep"
            value={lastV != null ? `${lastV.toFixed(2)} m/s` : 'no scale was set'}
          />
          <Row label="Reads as" value={reading ? `RPE ${effectiveRpe(reading, analysis.calledRpe)}` : '—'} />
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
            {analysis.athleteId
              ? `Read against ${analysis.athleteName ?? 'the athlete'}'s own saved sets, stored 1RM speed and recorded max where there are any, the same way as on the tracking page. Where there are none, the published reference for this lift is used.`
              : 'No athlete is attached, so this is read off the published reference for this lift.'}
          </p>
        </div>
      </div>
    </div>
  )
}

function SetContextEditor({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: { lift: string | null; loadKg: number | null; calledRpe: number | null; notes: string | null }
  saving: boolean
  onCancel: () => void
  onSave: (change: { lift: string | null; loadKg: number | null; calledRpe: number | null; notes: string | null }) => void
}) {
  const [lift, setLift] = useState(initial.lift ?? '')
  const [note, setNote] = useState(initial.notes ?? '')
  const [loadText, setLoadText] = useState(initial.loadKg != null ? String(initial.loadKg) : '')
  const [rpe, setRpe] = useState(initial.calledRpe != null ? String(initial.calledRpe) : '')
  const parsedLoad = loadText.trim() ? num(loadText) : null
  const loadValid = parsedLoad === null || (Number.isFinite(parsedLoad) && parsedLoad > 0 && parsedLoad <= 1000)

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Lift</span>
        <select value={lift} onChange={(e) => setLift(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-sm">
          <option value="">not recorded</option>
          {VBT_LIFTS.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Load (kg)</span>
        <input
          value={loadText}
          onChange={(e) => setLoadText(e.target.value)}
          inputMode="decimal"
          className="w-24 rounded-md border bg-background px-2 py-1 text-right text-sm"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">RPE called</span>
        <select value={rpe} onChange={(e) => setRpe(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-sm">
          <option value="">—</option>
          {RPE_VALUES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-muted-foreground">Note on this set</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={2000}
          className="w-full rounded-md border bg-background px-2 py-1 text-sm"
        />
      </label>
      {!loadValid && <p className="text-xs text-destructive">Load must be a number of kilograms up to 1000.</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button
          size="sm"
          disabled={saving || !loadValid}
          onClick={() => onSave({ lift: lift || null, loadKg: parsedLoad, calledRpe: rpe ? Number(rpe) : null, notes: note.trim() || null })}
        >
          Save
        </Button>
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
