import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  Columns2,
  Crosshair,
  Loader2,
  Palette,
  PersonStanding,
  RotateCcw,
  Ruler,
  Save,
  Target,
  Undo2,
  UserRound,
  X,
} from 'lucide-react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import { Button } from '../components/ui/button'
import { useToast } from '../components/ui/toast'
import AnalysisStage, {
  type CalibrationLine,
  type SeedPoint,
  type StageMode,
} from '../components/analysis/AnalysisStage'
import VideoPicker, { type AnalysisSource } from '../components/analysis/VideoPicker'
import DrawControls from '../components/analysis/DrawControls'
import type { Stroke } from '../components/analysis/annotations'
import { useTracker, type TrackStream } from '../components/analysis/useTracker'
import { captureInto } from '../components/analysis/captureFrames'
import type { Sample, TrackQuality } from '../components/analysis/tracker.core'
import { TRACKER_COLORS, useShowPose, useTrackerColor } from '../components/analysis/trackerColor'
import { usePose, type PoseStream } from '../components/analysis/usePose'
import { savePose, putCorrection } from '../components/analysis/poseApi'
import {
  applyCorrections,
  correctionsAtTimes,
  smooth,
  type PoseFrame,
  type TimedCorrection,
} from 'coachboard-shared/pose'
import {
  analysePath,
  looksMistracked,
  pixelsPerMetreFromPlate,
  PLATE_DIAMETERS_MM,
  type RepMetrics,
} from 'coachboard-shared/videoAnalysis'
import {
  defaultVelocityMetric,
  lastRepVelocity,
  liftLabel,
  measuredMvt,
  readRep,
  rpeFromLastRepVelocity,
  zoneFor,
} from 'coachboard-shared/vbt'
import VelocityPanel, {
  rememberedLift,
  type SetContextState,
} from '../components/analysis/VelocityPanel'
import {
  useVbtHistory,
  useAthleteMaxes,
  useAthleteMvt,
} from '../components/analysis/useVbtHistory'
import { useConfirm } from '../components/ui/confirm-dialog'
import SavedAnalyses from '../components/analysis/SavedAnalyses'
import { num } from '../lib/num'
import { uploadVideo } from '../lib/uploadAnalysisVideo'

type Phase = 'idle' | 'capturing' | 'tracking' | 'done'

/**
 * Below this the numbers stop meaning anything, so no path is shown at all.
 *
 * Reading a frame off a playing video costs enough that roughly one frame in
 * three is missed, so 30 fps footage yields ~18-20 samples per second. That is
 * still several points per velocity window, so the floor sits below it — the
 * gate is here to catch genuinely unusable captures, not normal ones.
 */
const MIN_EFFECTIVE_FPS = 12
const MIN_SURVIVAL = 0.4

/**
 * Capture width for the live pose preview.
 *
 * 512, and the number was measured. The 11e-0 spike found input width barely
 * affected SPEED and I wrongly carried that over to accuracy — it does not
 * follow. MediaPipe detects the person and then runs the landmark model on a
 * CROP of them, so a lifter who is a quarter of the frame becomes a tiny,
 * upsampled crop when the frame is small. On a real squat clip, mean lower-body
 * visibility went 0.83 at 256 to 0.88 at 384-512, and inference time was FLAT at
 * 70-80 ms across every width from 256 to 1080. So 256 was giving away accuracy
 * for nothing.
 *
 * Past ~512 it stops improving: 720 and 1080 measured no better, and cost a
 * larger readback on the main thread each time.
 */
const POSE_PREVIEW_WIDTH = 512

/**
 * Floor on the gap between preview inferences WHILE PLAYING.
 *
 * Roughly six a second. Enough that the skeleton visibly follows the lift, far
 * short of the per-frame rate that made playback stutter — every read is a full
 * canvas readback on the main thread with an inference behind it. Paused and
 * seeking are not throttled at all: that is where the coach reads a position.
 */
const PREVIEW_MIN_INTERVAL_MS = 160

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function VideoAnalysis() {
  const { mediaId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** The path as it is being tracked — see the note where it is filled. */
  const livePathRef = useRef<Sample[]>([])
  /**
   * The skeleton, in two layers. Refs for the same reason livePathRef is one.
   *
   * `measured` is exactly what the model produced; `poseRef` is that with the
   * coach's corrections on top, and is what the overlay draws. Kept apart so a
   * correction never overwrites a measurement — the same rule the saved page
   * follows, and the reason re-tracking cannot destroy a fix.
   */
  const poseMeasuredRef = useRef<PoseFrame[]>([])
  const poseRef = useRef<PoseFrame[]>([])
  /**
   * Corrections pinned to a TIME rather than a frame index.
   *
   * A fix made on the preview has to survive tracking, which rebuilds the track
   * from scratch at a different frame rate — every index changes, the moment
   * does not. Mirrored into a ref because the frame loop above cannot see state.
   */
  const [poseCorrections, setPoseCorrections] = useState<TimedCorrection[]>([])
  const poseCorrectionsRef = useRef<TimedCorrection[]>([])
  const { status: cvStatus, error: cvError, openStream } = useTracker()
  const pose = usePose()

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
  const [showPose, setShowPose] = useShowPose()
  const [plateMm, setPlateMm] = useState<number>(PLATE_DIAMETERS_MM[0].value)
  const [mode, setMode] = useState<StageMode>('seed')
  /**
   * Freehand marks the coach has drawn over the lift.
   *
   * Deliberately NOT saved with the analysis. These are for the moment of
   * explanation — drawn while talking, captured by the screen recorder — not a
   * measurement, and the analysis is a record of what was measured. They clear
   * with the clip like the seed and the range do.
   */
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [calibration, setCalibration] = useState<CalibrationLine | null>(null)
  const [awaitingSecondPoint, setAwaitingSecondPoint] = useState(false)
  /** Shown once a track finishes, so nothing is stored without being asked for. */
  const [offerSave, setOfferSave] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /**
   * Who this set belongs to.
   *
   * Was previously taken from the Discord clip alone, so a local file always
   * saved with no athlete — orphaned, invisible to every profile it should have
   * fed, and impossible to attach afterwards. Null means "not chosen yet";
   * 'none' is the coach explicitly saying this is a throwaway look.
   */
  const [athleteChoice, setAthleteChoice] = useState<string | null>(null)
  const [roster, setRoster] = useState<{ id: string; name: string; height_cm: number | null }[]>([])
  const [savedCount, setSavedCount] = useState(0)
  /** What the set was — the lift and load every velocity readout is judged against. */
  const [setContext, setSetContext] = useState<SetContextState>({
    lift: rememberedLift(),
    loadText: '',
    calledRpe: null,
    repsText: '',
    metric: null,
  })

  /**
   * Everything below belongs to ONE video, and React Router keeps this page
   * mounted when the :mediaId param changes rather than remounting it. Without
   * this reset the previous video's analysis bleeds into the next one — open a
   * second clip from the inbox and you would see the first clip's bar path
   * drawn over it, with its calibration and rep numbers still on screen.
   */
  useEffect(() => {
    // A different clip shares nothing with the last one's skeleton, corrections
    // included — those are statements about a body in a particular video.
    poseMeasuredRef.current = []
    poseRef.current = []
    poseCorrectionsRef.current = []
    setPoseCorrections([])
    setSeed(null)
    setSamples(null)
    setQuality(null)
    setPhase('idle')
    setCalibration(null)
    setAwaitingSecondPoint(false)
    setMode('seed')
    setStrokes([])
    setRange(null)
    setDuration(0)
    setCurrentTime(0)
    setNotFound(false)
    // Load and called RPE belong to one set and must not bleed into the next
    // clip; the lift is kept, because a coach reviews a whole inbox of squats.
    setSetContext((c) => ({ ...c, loadText: '', calledRpe: null, repsText: '', metric: null }))
    setAthleteChoice(null)
    // Leaving the deep link entirely (back to /analysis) means no video at all,
    // so the picker takes over. A locally-imported file has no id and must
    // survive this, hence only clearing when the param is genuinely absent.
    if (!mediaId) setSource(null)
  }, [mediaId])

  // The roster, for attaching a local clip to whoever is in it.
  useEffect(() => {
    let cancelled = false
    fetch('/api/athletes')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: { id: string; name: string; height_cm: number | null; archived?: number }[]) => {
        if (cancelled) return
        setRoster(
          (Array.isArray(data) ? data : [])
            .filter((a) => !a.archived)
            .map((a) => ({ id: a.id, name: a.name, height_cm: a.height_cm ?? null })),
        )
      })
      .catch(() => !cancelled && setRoster([]))
    return () => {
      cancelled = true
    }
  }, [])

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

  /**
   * Clicking the bar places the tracking point AND starts tracking.
   *
   * Tracking runs from the current playhead to the end of the marked range, so
   * clicking at the moment the lift begins is all the setup a coach needs.
   */
  const placeSeed = (point: { x: number; y: number }) => {
    const video = videoRef.current
    if (!video) return
    const next: SeedPoint = {
      x: point.x,
      y: point.y,
      radius: seed?.radius ?? Math.max(24, Math.round(video.videoWidth * 0.07)),
    }
    setSeed(next)
    setQuality(null)

    const from = video.currentTime
    const to = range && range.to > from + 0.2 ? range.to : duration
    setRange({ from, to })
    void runTracking(next, from, to)
  }

  /** Re-runs from the same point, after a resize or a range change. */
  const retrack = () => {
    const video = videoRef.current
    if (!video || !seed || !range) return
    void runTracking(seed, range.from, range.to)
  }

  /**
   * Arms calibration and brings the video back into view.
   *
   * Reachable from the velocity panel far below the stage, where the missing
   * scale is what a coach actually notices — arming the mode without scrolling
   * would leave them looking at a button that appeared to do nothing.
   */
  const startCalibration = () => {
    setMode('calibrate')
    setAwaitingSecondPoint(false)
    videoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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

  // Memoised because it walks the whole path twice (velocity, then rep
  // segmentation), and it MUST sit above the early returns below — a hook after
  // a conditional return changes the hook count between renders, which React
  // rejects outright.
  const trackedReps: RepMetrics[] = useMemo(
    () => (samples ? analysePath(samples, pixelsPerMetre).reps : []),
    [samples, pixelsPerMetre],
  )

  /**
   * Reps the coach has struck off, by index into `trackedReps`.
   *
   * The segmenter drops obvious noise on its own, but it cannot know that a
   * re-rack, a failed attempt or a bounced walkout was not a rep. Everything
   * downstream — velocity loss, the RPE reading, the 1RM estimate, and what gets
   * saved — reads the filtered list, so one bad cycle cannot quietly skew the
   * athlete's whole profile.
   */
  const [excludedReps, setExcludedReps] = useState<Set<number>>(new Set())

  // A fresh track renumbers everything, so carrying exclusions over would strike
  // off arbitrary reps of a different set. Keyed on `samples` so every path that
  // clears or replaces a track is covered, rather than each one remembering to.
  useEffect(() => {
    setExcludedReps(new Set())
  }, [samples])

  const reps: RepMetrics[] = useMemo(
    () => trackedReps.filter((r) => !excludedReps.has(r.index)),
    [trackedReps, excludedReps],
  )

  const toggleRep = (index: number) =>
    setExcludedReps((prev) => {
      const next = new Set(prev)
      if (!next.delete(index)) next.add(index)
      return next
    })

  // The load as a number, or null — a half-typed "1" is not a load to save.
  const parsedLoad = setContext.loadText.trim() ? num(setContext.loadText) : null
  const loadKg = parsedLoad != null && Number.isFinite(parsedLoad) && parsedLoad > 0 ? parsedLoad : null


  // The athlete's own velocity history for this lift. Resolved here rather than
  // inside the panel because the rep table below reads the same anchors — two
  // different estimated RPEs for one rep would be worse than none.
  const clipAthleteId = source?.kind === 'discord' ? source.item.athleteId : null
  // An explicit choice wins; otherwise fall back to whoever posted the clip.
  // 'none' is a deliberate "do not attach this one".
  const athleteId =
    athleteChoice === 'none' ? null : (athleteChoice ?? clipAthleteId)
  const athleteName =
    roster.find((a) => a.id === athleteId)?.name ??
    (source?.kind === 'discord' ? source.item.athleteName : null)
  // Lets the panel judge the plate scale against how far this lifter's bar
  // should actually travel, instead of a band wide enough to cover everyone.
  const athleteHeightCm = roster.find((a) => a.id === athleteId)?.height_cm ?? null
  const metric = setContext.metric ?? defaultVelocityMetric(setContext.lift)
  const { anchors: savedAnchors, points: savedPoints } = useVbtHistory(
    athleteId,
    setContext.lift,
    metric,
  )
  const athleteMaxes = useAthleteMaxes(athleteId)
  // Resolved here rather than in the panel because saving a set can also MEASURE
  // this number, and the page is what knows a save happened.
  const athleteMvt = useAthleteMvt(athleteId)
  const storedMvt = athleteMvt.byLift[setContext.lift] ?? null
  const lastV = pixelsPerMetre !== null ? lastRepVelocity(reps, metric) : null
  const anchors = useMemo(
    () =>
      setContext.calledRpe != null && lastV != null
        ? [...savedAnchors, { rpe: setContext.calledRpe, velocity: lastV }]
        : savedAnchors,
    [savedAnchors, setContext.calledRpe, lastV],
  )

  const resizeSeed = (delta: number) => {
    const video = videoRef.current
    if (!video) return
    setSeed((s) =>
      s ? { ...s, radius: Math.min(video.videoWidth / 2, Math.max(12, s.radius + delta)) } : s,
    )
  }

  /**
   * Tracks from `seedPoint` to the end of the marked range, drawing as it goes.
   *
   * Runs automatically when the coach clicks the bar — there is nothing useful
   * to do between placing a point and tracking it, so making them press a
   * second button only added a step. The path appears live because frames are
   * streamed to the tracker as they decode rather than collected first.
   */
  const runTracking = async (seedPoint: SeedPoint, from: number, to: number) => {
    const video = videoRef.current
    if (!video) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setPhase('capturing')
    setProgress(0)
    setSamples(null)
    setQuality(null)
    let lastProgressAt = 0

    // A holder rather than a bare `let`: it is only ever assigned inside the
    // capture callback, which TypeScript's flow analysis cannot see, so a plain
    // variable narrows to `never` everywhere afterwards.
    const streamRef: { current: TrackStream | null } = { current: null }
    let scale = 1
    // Live points go into a ref, NOT state. Calling setSamples once per frame
    // re-rendered the page and re-ran the metrics over the whole growing array
    // thirty times a second, which starved the capture loop badly enough to
    // halve the effective frame rate — 15 fps out of 30 fps footage, which the
    // quality gate then correctly rejected. The overlay reads this ref directly.
    livePathRef.current = []
    // The measurement is rebuilt by this pass; the CORRECTIONS deliberately are
    // not cleared. A coach who fixed a knee on the preview has not withdrawn
    // that opinion by tracking the bar, and the fixes are pinned to a time, so
    // they land correctly on the new frames.
    poseMeasuredRef.current = []
    poseRef.current = []

    // Opened BEFORE capture, not during: loading the model is ~0.3 s plus a
    // 5.8 MB fetch on first use, and doing that inside the first frame callback
    // would stall the capture loop long enough to trip its own stall timeout.
    // A pose failure is reported and then ignored — the bar path is the
    // measurement and must not go down with the commentary on it.
    let poseStream: PoseStream | null = null
    if (showPose) {
      try {
        poseStream = await pose.open({
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          // VIDEO here, unlike the preview: this pass plays the clip forwards
          // once, which is exactly the case the region-of-interest reuse was
          // chosen for. No seed — this pass rebuilds the track.
          mode: 'VIDEO',
        })
      } catch {
        toast.error('Could not start pose estimation — tracking the bar path only.')
      }
    }

    try {
      const handle = await captureInto(
        video,
        async (frame, isFirst) => {
          if (isFirst) {
            scale = frame.width / video.videoWidth
            streamRef.current = openStream(frame, {
              x: (seedPoint.x - seedPoint.radius) * scale,
              y: (seedPoint.y - seedPoint.radius) * scale,
              width: seedPoint.radius * 2 * scale,
              height: seedPoint.radius * 2 * scale,
            })
            // The seed frame's own sample comes back from streamStart.
            return null
          }
          return streamRef.current ? streamRef.current.push(frame) : null
        },
        {
          from,
          to,
          signal: controller.signal,
          onSample: (sample, fraction) => {
            if (sample) {
              livePathRef.current.push({ t: sample.t, x: sample.x / scale, y: sample.y / scale })
            }
            // Progress drives a percentage readout, so a few updates a second
            // is plenty; per-frame would reintroduce the same render storm.
            const now = performance.now()
            if (now - lastProgressAt > 200) {
              lastProgressAt = now
              setProgress(fraction)
            }
          },
          // The fan-out: pose reads the frames the tracker is already pulling,
          // so the coach waits exactly as long as tracking takes today. The ref
          // is filled by the stream itself, and the overlay reads it directly —
          // same reason livePathRef is a ref.
          alsoPush: poseStream
            ? async (frame) => {
                await poseStream!.push(frame)
                poseMeasuredRef.current = poseStream!.frames
                // Corrections made on the preview are pinned to a moment, so
                // they land on the right frames of the rebuilt track without
                // anything having to migrate them.
                redrawPose()
              }
            : undefined,
        },
      )

      if (!streamRef.current) {
        toast.error('No frames could be read from that range.')
        setPhase('idle')
        return
      }

      // Note: an aborted run is NOT discarded. Capture stops early but the
      // frames already tracked are perfectly good, so stopping is "I have seen
      // enough reps" rather than "throw it away" — which matters on a long clip
      // where the coach only cares about the first set.
      const result = await streamRef.current.finish()

      const q = result.quality
      if (handle.framesRead < 5) {
        toast.error('Not enough frames in that range — widen it and try again.')
        setSamples(null)
        setPhase('idle')
        return
      }
      if (q.effectiveFps < MIN_EFFECTIVE_FPS || q.medianSurvivalRate < MIN_SURVIVAL) {
        // Deliberately show nothing rather than a path we do not trust — a
        // wrong number costs more credibility than an absent one.
        setQuality(q)
        setSamples(null)
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
      setSavedId(null)
      setOfferSave(true)
      video.currentTime = from
    } catch (err) {
      if (!controller.signal.aborted) {
        toast.error(err instanceof Error ? err.message : 'Tracking failed')
      }
      streamRef.current?.cancel()
      setSamples(null)
      setPhase('idle')
    } finally {
      // The model heap is not reclaimed by dropping the reference, and the
      // skeleton already found stays drawable from poseRef without it.
      poseStream?.close()
    }
  }

  /** Stops capture early and keeps whatever has been tracked so far. */
  const cancelTracking = () => {
    abortRef.current?.abort()
  }

  const saveAnalysis = async () => {
    if (!samples) return
    setSaving(true)
    try {
      // A Discord clip is already on disk and the analysis just references it.
      // A local import is the only one that needs a copy, and it is uploaded
      // BEFORE the row is written so a failed upload leaves nothing behind —
      // better a save the coach can retry than a row pointing at no video.
      const stored = source?.kind === 'local' ? await uploadVideo(source.file) : null

      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaId: source?.kind === 'discord' ? source.item.id : null,
          athleteId,
          sourceLabel: sourceLabel,
          track: samples,
          calibration: calibration ? { ...calibration, plateDiameterMm: plateMm } : null,
          metrics: reps,
          notes: null,
          // Only when the velocity panel was actually on screen. With no reps
          // detected it is hidden, and storing the lift it happens to remember
          // would be recording a guess the coach never saw.
          lift: reps.length > 0 ? setContext.lift : null,
          loadKg: loadKg,
          calledRpe: setContext.calledRpe,
          // Stored so reopening reads the set the same way this page did.
          metric: reps.length > 0 ? metric : null,
          videoPath: stored?.relPath ?? null,
          videoBytes: stored?.bytes ?? null,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const saved = (await res.json()) as { id: string }
      setSavedId(saved.id)
      setOfferSave(false)
      setSavedCount((n) => n + 1)
      toast.success('Analysis saved')

      // The skeleton rides along in its own request. Separate because it is
      // ~238 KB against the analysis's ~10 KB and almost every read of an
      // analysis does not want it — and because failing to store it must not
      // cost the coach the bar path, which is the actual measurement.
      if (poseMeasuredRef.current.length > 0) {
        try {
          // The MEASUREMENT is stored, never the corrected copy — the whole
          // point of keeping them in two layers is that re-running the model
          // cannot destroy a fix, and that only holds if the fix was never
          // baked into what the model said.
          await savePose(saved.id, poseMeasuredRef.current)
          for (const c of correctionsAtTimes(poseMeasuredRef.current, poseCorrections)) {
            await putCorrection(saved.id, c)
          }
        } catch {
          toast.error('The analysis was saved, but the skeleton could not be.')
        }
      }

      // Last, because it can open a dialog and wait on the coach. Everything
      // above is a write that should already have landed by the time a modal
      // takes over the window.
      await offerMeasuredMvt()
    } catch {
      toast.error('Could not save that analysis.')
    } finally {
      setSaving(false)
    }
  }

  /**
   * A set called RPE 10 has just measured this athlete's 1RM velocity. Offer it.
   *
   * Only ever downwards. The MVT is a floor — the slowest a maximum can still be
   * completed — so a slower max is evidence the stored number was too high,
   * while a faster one only says this attempt was not the athlete's worst day.
   *
   * It asks rather than writing, because nothing ever raises the number back: a
   * single mistracked rep accepted silently would quietly deflate every 1RM
   * estimate for that lift from then on, with no symptom pointing at the cause.
   *
   * Runs after the save has landed, so a failed save never edits the athlete.
   */
  const offerMeasuredMvt = async () => {
    if (!athleteId || reps.length === 0) return
    const measured = measuredMvt(reps, { calledRpe: setContext.calledRpe, metric })
    if (measured == null) return
    if (storedMvt != null && measured >= storedMvt) return

    const who = athleteName ?? 'this athlete'
    const ok = await confirm({
      title: `Update ${who}'s 1RM velocity?`,
      description:
        `This ${liftLabel(setContext.lift)} set was called RPE 10 and its last rep moved at ` +
        `${measured.toFixed(2)} m/s` +
        (storedMvt != null
          ? `, below the ${storedMvt.toFixed(2)} m/s stored for ${who}.`
          : `, and nothing is stored for ${who} yet.`) +
        ` Every future 1RM estimate for this lift will be judged against it.`,
      confirmLabel: 'Update',
      cancelLabel: 'Keep current',
    })
    if (!ok) return
    try {
      await athleteMvt.save(setContext.lift, measured)
      toast.success(`1RM velocity for ${liftLabel(setContext.lift)} is now ${measured.toFixed(2)} m/s`)
    } catch {
      toast.error('Could not save that 1RM velocity.')
    }
  }

  const reset = () => {
    abortRef.current?.abort()
    livePathRef.current = []
    // Clear is "start this clip over", so the corrections go too.
    poseMeasuredRef.current = []
    poseRef.current = []
    poseCorrectionsRef.current = []
    setPoseCorrections([])
    setSeed(null)
    setSamples(null)
    setQuality(null)
    setPhase('idle')
    setCalibration(null)
    setAwaitingSecondPoint(false)
    setMode('seed')
    setStrokes([])
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

  // ------------------------------------------------------------------
  // Pose state and its preview loop.
  //
  // ABOVE the early returns below, and it has to stay there: this page
  // renders a picker until a clip is chosen, and hooks declared after a
  // conditional return run on some renders and not others. React counts them
  // and throws #310 the moment the count changes — which is exactly what
  // picking a video did.
  // ------------------------------------------------------------------
  const busy = phase === 'capturing' || phase === 'tracking'
  // redrawPose reads this from a ref rather than a dep, so it stays a stable
  // callback across the thirty-a-second calls it takes during tracking.
  const busyRef = useRef(busy)
  busyRef.current = busy

  /**
   * Jitter-filtered copy of a finished track, memoised on the source array.
   *
   * `smooth` costs 19 ms for a 300-frame track and 55 ms for 900 — measured —
   * so running it per redraw would eat most of a core at thirty redraws a
   * second, which is exactly the rebuild the note on redrawPose warns about.
   * The source array is replaced wholesale rather than mutated, so identity is a
   * sound cache key.
   *
   * Skipped while frames are still arriving, and not only to save the work: a
   * median window needs neighbours on BOTH sides, so the newest frame — the one
   * being drawn during live tracking — is the one it can do least for.
   */
  const poseSmoothCache = useRef<{ source: PoseFrame[]; result: PoseFrame[] } | null>(null)
  const smoothedPose = (measured: PoseFrame[]): PoseFrame[] => {
    if (busyRef.current || measured.length < 3) return measured
    if (poseSmoothCache.current?.source === measured) return poseSmoothCache.current.result
    const result = smooth(measured)
    poseSmoothCache.current = { source: measured, result }
    return result
  }

  /**
   * Re-layers the corrections over the measurement.
   *
   * Called on every new pose frame and on every drag. `applyCorrections` hands
   * the same array straight back when there is nothing to apply, so the common
   * case — no corrections at all — costs one comparison rather than rebuilding
   * three hundred frames thirty times a second.
   *
   * Smoothing happens HERE rather than before saving, because the stored track
   * is the measurement and a median filter is a reconstruction — the same reason
   * the corrected copy is never what gets stored. Corrections are applied AFTER
   * the filter so a joint the coach placed by hand wins outright instead of
   * being median-ed back toward where the model had it.
   */
  const redrawPose = useCallback(() => {
    const measured = smoothedPose(poseMeasuredRef.current)
    const timed = poseCorrectionsRef.current
    poseRef.current = timed.length
      ? applyCorrections(measured, correctionsAtTimes(measured, timed))
      : measured
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Records a joint the coach has moved, against the moment it belongs to. */
  const correctPoseLandmark = useCallback(
    (frameIndex: number, landmark: number, x: number, y: number) => {
      const t = poseMeasuredRef.current[frameIndex]?.t
      if (t == null) return
      setPoseCorrections((prev) => {
        const next = [
          ...prev.filter((c) => !(c.landmark === landmark && c.t === t)),
          { t, landmark, x, y },
        ]
        poseCorrectionsRef.current = next
        redrawPose()
        return next
      })
    },
    [redrawPose],
  )

  /**
   * The skeleton before any tracking has happened.
   *
   * Pose used to run ONLY inside the tracking pass, which meant switching it on
   * did nothing until the coach placed a point and tracked the bar — and there
   * was no way to fix a joint before committing to a run. This reads whatever
   * frame is on screen instead: switch it on and the lifter has a skeleton,
   * scrub and it follows, drag a joint and the fix sticks.
   *
   * Frames come off requestVideoFrameCallback, which fires when the compositor
   * presents one — on load, on every seek, and continuously during playback. So
   * a paused clip costs one inference and a played one costs the same as
   * tracking would.
   *
   * Stops while tracking, which opens its own stream and reads the same frames
   * through captureInto's fan-out. Two model instances competing for one CPU
   * would slow the pass the fan-out exists to keep free.
   */
  useEffect(() => {
    const video = videoRef.current
    if (!showPose || busy || !source || !video) return

    let cancelled = false
    let stream: PoseStream | null = null
    let pending: number | null = null
    /** Removes the seek listener; only set once the loop is actually running. */
    let detach: (() => void) | null = null

    const start = async () => {
      // Metadata may not have landed yet; without dimensions there is nothing to
      // normalise landmarks against.
      if (!video.videoWidth) {
        await new Promise<void>((resolve) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true })
        })
      }
      if (cancelled || !video.videoWidth) return

      try {
        stream = await pose.open({
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          // IMAGE, not VIDEO. The coach scrubs, and VIDEO mode carries a region
          // of interest forward and demands rising timestamps — so a jump
          // backwards hands it an image from elsewhere while the clock says a
          // millisecond passed, and the skeleton comes back stale or bent onto
          // the wrong part of the frame. IMAGE treats each frame on its own.
          mode: 'IMAGE',
          // Seeded with what the preview already found, so switching the
          // skeleton off and back on continues rather than starting over.
          seed: poseMeasuredRef.current,
        })
      } catch {
        return // usePose has already reported it; the toolbar shows why.
      }
      if (cancelled) {
        stream.close()
        return
      }

      const width = POSE_PREVIEW_WIDTH
      const height = Math.round((width / video.videoWidth) * video.videoHeight)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      let working = false

      /** Reads whatever the video is showing right now, at time `t`. */
      const readCurrentFrame = (t: number) => {
        // Frames arriving while the previous one is still in the model are
        // skipped, not queued — the same rule captureInto's fan-out follows.
        if (cancelled || !stream || working) return
        working = true
        // Drawn from the video element, never createImageBitmap: the bitmap path
        // applies its resize before the clip's rotation metadata and hands back
        // sideways content for a portrait clip.
        ctx.drawImage(video, 0, 0, width, height)
        const data = ctx.getImageData(0, 0, width, height).data
        void stream
          .push({ t, width, height, data })
          .then(() => {
            if (cancelled || !stream) return
            poseMeasuredRef.current = stream.frames
            redrawPose()
          })
          .finally(() => {
            working = false
          })
      }

      /**
       * Throttled DURING PLAYBACK, and not at all when paused or seeking.
       *
       * Reading a frame costs a full getImageData off the main thread, and
       * running one on every presented frame — plus an inference behind it —
       * made playback visibly stutter. The preview is for looking at a position,
       * not for building a dense track; that is what the tracking pass is for,
       * where the frames are wanted anyway.
       *
       * So while the clip is playing the skeleton refreshes a few times a second
       * and the video plays smoothly. Pausing or scrubbing gets an immediate
       * read, because that is where the coach is actually reading a position and
       * correcting a joint.
       */
      let lastRunAt = 0
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        if (cancelled || !stream) return
        const now = performance.now()
        if (now - lastRunAt >= PREVIEW_MIN_INTERVAL_MS) {
          lastRunAt = now
          readCurrentFrame(meta.mediaTime)
        }
        pending = video.requestVideoFrameCallback(onFrame)
      }

      /**
       * A CLIP IS PAUSED WHEN IT LOADS, AND THAT IS THE WHOLE POINT.
       *
       * requestVideoFrameCallback fires when the compositor PRESENTS a frame. A
       * paused video that has already painted presents nothing further, so a
       * loop built only on rVFC never runs a single inference — switch the
       * skeleton on and it sits there looking broken until you happen to press
       * play. That is what shipped, and every check here passed because the
       * probe played the clip first.
       *
       * So the frame on screen is read immediately, and again after every seek,
       * with rVFC covering playback.
       */
      readCurrentFrame(video.currentTime)
      const onSeeked = () => readCurrentFrame(video.currentTime)
      video.addEventListener('seeked', onSeeked)
      detach = () => video.removeEventListener('seeked', onSeeked)

      pending = video.requestVideoFrameCallback(onFrame)
    }

    void start()
    return () => {
      cancelled = true
      if (pending !== null) video.cancelVideoFrameCallback?.(pending)
      detach?.()
      stream?.close()
    }
    // Deliberately NOT depending on redrawPose or pose: both are stable, and
    // re-running this would tear the model down and rebuild it — a ~0.3 s stall
    // and a lost preview — on every render.
  }, [showPose, busy, source])

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
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-lg font-semibold">Bar path analysis</h1>
              <p className="text-sm text-muted-foreground">
                Track the bar through a lift to see its path and per-rep velocity.
              </p>
            </div>
            {/* Beside picking a clip rather than under the saved list: comparing
                two lifts is a way to START, not an afterthought once you have
                scrolled past everything else. */}
            <Button variant="outline" size="sm" onClick={() => navigate('/analysis/compare')}>
              <Columns2 className="h-4 w-4" />
              Compare two lifts
            </Button>
          </div>
        </div>
        {mediaId ? (
          <p className="text-sm text-muted-foreground">Loading video…</p>
        ) : (
          <>
            <VideoPicker onPick={setSource} />
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Saved analyses</h2>
              <SavedAnalyses limit={10} athletes={roster} refreshKey={savedCount} />
            </div>
          </>
        )}
      </div>
    )
  }

  const canTrack = !!seed && cvStatus === 'ready' && !busy && !!range

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
          livePathRef={livePathRef}
          poseRef={poseRef}
          showPose={showPose}
          onCorrectLandmark={correctPoseLandmark}
          onPlaceSeed={placeSeed}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={setCurrentTime}
          disabled={busy}
          color={color}
          mode={mode}
          calibration={calibration}
          onCalibratePoint={addCalibrationPoint}
          strokes={strokes}
          onDrawStroke={(s) => setStrokes((prev) => [...prev, s])}
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

              {/* Locked only WHILE a run is under way — the fan-out that feeds
                  pose is set up at the start of that pass, so switching it
                  mid-track would silently do nothing. Otherwise it takes effect
                  at once: the preview runs on whatever frame is on screen. */}
              <label
                className={`flex items-center gap-1.5 text-sm ${busy ? 'opacity-50' : ''}`}
                title={
                  busy
                    ? 'Pose cannot be switched during a tracking run'
                    : 'Draw the lifter’s skeleton — drag a joint to correct it'
                }
              >
                <input
                  type="checkbox"
                  checked={showPose}
                  disabled={busy}
                  onChange={(e) => setShowPose(e.target.checked)}
                  className="h-3.5 w-3.5 accent-cyan-400"
                />
                <PersonStanding className="h-4 w-4 text-muted-foreground" />
                Skeleton
              </label>
              {pose.status === 'loading' && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the pose model…
                </span>
              )}
              {pose.status === 'error' && (
                <span className="text-xs text-destructive">Skeleton unavailable: {pose.error}</span>
              )}
              {poseCorrections.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {poseCorrections.length} joint{poseCorrections.length === 1 ? '' : 's'} corrected
                </span>
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
              {busy ? (
                <Button variant="outline" onClick={cancelTracking}>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {`Tracking… ${Math.round(progress * 100)}% — stop and keep`}
                </Button>
              ) : (
                <Button onClick={retrack} disabled={!canTrack}>
                  <Target className="h-4 w-4" />
                  {samples ? 'Track again' : 'Track bar path'}
                </Button>
              )}
              {(seed || samples) && (
                <Button variant="ghost" onClick={reset} disabled={busy}>
                  <RotateCcw className="h-4 w-4" /> Clear
                </Button>
              )}

              {/* Drawing on the lift. Fullscreen is NOT here — it belongs in the
                  video's own control bar, where a fullscreen button always is,
                  and the stage puts it there itself. */}
              <div className="ml-auto">
                <DrawControls
                  mode={mode}
                  onModeChange={(next) => {
                    setMode(next)
                    setAwaitingSecondPoint(false)
                  }}
                  strokes={strokes}
                  onStrokesChange={setStrokes}
                />
              </div>
            </div>

            {busy && (
              <p className="text-xs text-muted-foreground">
                Frames are read while the clip plays, so this takes about as long as the range
                itself. The path draws as it goes.
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

            {/* Asked, never assumed: an analysis is only stored if the coach
                says so, so a throwaway look at a clip leaves nothing behind. */}
            {offerSave && samples && (
              <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Save className="h-4 w-4 text-primary" />
                  <span className="text-sm">
                    Save this analysis?
                    <span className="ml-1 text-muted-foreground">
                      {reps.length > 0
                        ? `${reps.length} ${reps.length === 1 ? 'rep' : 'reps'}, bar path and scale are kept.`
                        : 'The bar path is kept.'}
                      {loadKg != null &&
                        ` The lift and ${loadKg} kg go with it, so the athlete's velocity profile builds up.`}
                      {source?.kind === 'local' &&
                        ' The video is copied into CoachBoard too, so you can watch it back later.'}
                    </span>
                  </span>
                </div>

                {/* Who it belongs to, asked before it is stored rather than
                    inferred from where the clip came from. A saved analysis with
                    no athlete feeds nobody's profile and is invisible on every
                    page that would show it. */}
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <UserRound className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Athlete</span>
                  <select
                    value={athleteChoice ?? clipAthleteId ?? ''}
                    onChange={(e) => setAthleteChoice(e.target.value || 'none')}
                    className="rounded-md border bg-background px-2 py-1 text-sm"
                  >
                    <option value="">Don&rsquo;t attach — just this once</option>
                    {roster.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  {athleteId == null && (
                    <span className="text-xs text-muted-foreground">
                      Saved without an athlete it counts towards nobody&rsquo;s velocity profile. You
                      can attach it later from the list below.
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button size="sm" onClick={saveAnalysis} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOfferSave(false)} disabled={saving}>
                    Not now
                  </Button>
                </div>
              </div>
            )}

            {savedId && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-emerald-500" /> Saved.
              </p>
            )}

            {samples && trackedReps.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-medium">
                  Concentric velocity — {reps.length} {reps.length === 1 ? 'rep' : 'reps'}
                  {excludedReps.size > 0 && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      ({excludedReps.size} struck off)
                    </span>
                  )}
                </h2>
                <p className="text-xs text-muted-foreground">
                  A cycle that was not a rep — a re-rack, a failed attempt, a bounce in the walkout —
                  skews everything measured from the set. Strike it off and every number below is
                  recalculated without it.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[30rem] text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1 pr-4 font-medium">Rep</th>
                        <th className={`py-1 pr-4 font-medium ${metric === 'mean' ? 'text-foreground' : ''}`}>
                          Mean{metric === 'mean' && ' •'}
                        </th>
                        <th className={`py-1 pr-4 font-medium ${metric === 'propulsive' ? 'text-foreground' : ''}`}>
                          Propulsive{metric === 'propulsive' && ' •'}
                        </th>
                        <th className={`py-1 pr-4 font-medium ${metric === 'peak' ? 'text-foreground' : ''}`}>
                          Peak{metric === 'peak' && ' •'}
                        </th>
                        <th className="py-1 pr-4 font-medium">Range</th>
                        <th className="py-1 pr-4 font-medium">Duration</th>
                        {/* Per-rep interpretation. Dropped entirely without a
                            scale line rather than shown as a column of dashes —
                            neither an RPE table nor a velocity zone means
                            anything against a pixels-per-second number. */}
                        {pixelsPerMetre !== null && (
                          <>
                            <th className="py-1 pr-4 font-medium">≈ RPE</th>
                            <th className="py-1 font-medium">Quality</th>
                          </>
                        )}
                        <th className="py-1 pl-4 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {trackedReps.map((r) => {
                        const excluded = excludedReps.has(r.index)
                        // Whatever velocity the panel reads the tables against,
                        // so one rep never carries two different RPEs.
                        const suspect = looksMistracked(r)
                        const v = readRep(r, metric)
                        const reading =
                          !excluded && v !== null
                            ? rpeFromLastRepVelocity(setContext.lift, v, { anchors })
                            : null
                        const zone = !excluded && v !== null ? zoneFor(v) : null
                        return (
                          <tr
                            key={r.index}
                            className={`border-b last:border-0 ${
                              excluded ? 'text-muted-foreground line-through opacity-60' : ''
                            }`}
                          >
                            <td className="py-1 pr-4">
                              {r.index + 1}
                              {suspect && !excluded && (
                                <span
                                  className="ml-1.5 text-amber-500"
                                  title="The peak is far out of line with the mean — the tracker probably jumped here. Strike this rep off or track it again."
                                >
                                  ⚠
                                </span>
                              )}
                            </td>
                            <td className="py-1 pr-4 font-medium">
                              {r.meanVelocity !== null
                                ? `${r.meanVelocity.toFixed(2)} m/s`
                                : `${Math.round(r.meanVelocityPxS)} px/s`}
                            </td>
                            <td className="py-1 pr-4 font-medium">
                              {r.meanPropulsiveVelocity !== null
                                ? `${r.meanPropulsiveVelocity.toFixed(2)} m/s`
                                : '—'}
                              {r.propulsiveFraction !== null && (
                                <span className="ml-1 text-xs font-normal text-muted-foreground">
                                  {Math.round(r.propulsiveFraction * 100)}%
                                </span>
                              )}
                            </td>
                            <td className="py-1 pr-4">
                              {r.peakVelocity !== null
                                ? `${r.peakVelocity.toFixed(2)} m/s`
                                : `${Math.round(r.peakVelocityPxS)} px/s`}
                            </td>
                            <td className="py-1 pr-4">
                              {r.romM !== null
                                ? `${(r.romM * 100).toFixed(0)} cm`
                                : `${Math.round(r.romPx)} px`}
                            </td>
                            <td className="py-1 pr-4">{(r.durationMs / 1000).toFixed(2)} s</td>
                            {pixelsPerMetre !== null && (
                              <>
                                <td className="py-1 pr-4">{reading ? reading.rpe : '—'}</td>
                                <td className="py-1 text-muted-foreground">{zone ? zone.label : '—'}</td>
                              </>
                            )}
                            <td className="py-1 pl-4 text-right">
                              <button
                                type="button"
                                onClick={() => toggleRep(r.index)}
                                title={excluded ? 'Count this rep again' : 'Not a rep — strike it off'}
                                aria-label={
                                  excluded ? `Count rep ${r.index + 1} again` : `Strike off rep ${r.index + 1}`
                                }
                                className="rounded p-1 text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
                              >
                                {excluded ? (
                                  <Undo2 className="h-3.5 w-3.5" />
                                ) : (
                                  <X className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Velocity-based readouts live in their own panel: they need the
                lift and load, which the tracker cannot know, and they are
                interpretation rather than measurement. */}
            {samples && reps.length > 0 && (
              <VelocityPanel
                reps={reps}
                calibrated={pixelsPerMetre !== null}
                athleteName={athleteName}
                athleteId={athleteId}
                storedMvt={storedMvt}
                onSaveMvt={(velocity) => athleteMvt.save(setContext.lift, velocity)}
                athleteHeightCm={athleteHeightCm}
                anchors={anchors}
                savedPoints={savedPoints}
                maxes={athleteMaxes}
                value={setContext}
                onChange={setSetContext}
                onSetScale={startCalibration}
              />
            )}

            {samples && trackedReps.length === 0 && (
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
