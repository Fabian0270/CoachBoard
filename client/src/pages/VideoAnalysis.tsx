import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Columns2,
  FileDown,
  Loader2,
  Save,
  Smartphone,
  UserRound,
} from 'lucide-react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import { Button } from '../components/ui/button'
import { useToast } from '../components/ui/toast'
import { ApiError, errorMessage, getJson, getList, sendJson } from '../lib/api'
import AnalysisStage, {
  repWindows,
  type CalibrationLine,
  type SeedPoint,
  type StageMode,
} from '../components/analysis/AnalysisStage'
import VideoPicker, { type AnalysisSource } from '../components/analysis/VideoPicker'
import type { Stroke } from '../components/analysis/annotations'
import { useTracker, type TrackStream } from '../components/analysis/useTracker'
import { captureInto } from '../components/analysis/captureFrames'
import type { Sample, TrackQuality } from '../components/analysis/tracker.core'
import { usePlateMm, useShowAngles, useShowMidFoot, useShowPose, useTrackerColor } from '../components/analysis/trackerColor'
import { midFootByRep } from '../components/analysis/midFoot'
import { usePose } from '../components/analysis/usePose'
import { readClipPose } from '../components/analysis/clipPose'
import { savePose, putCorrection } from '../components/analysis/poseApi'
import {
  MID_FOOT_LIFTS,
  applyCorrections,
  correctionsAtTimes,
  type PoseFrame,
  type TimedCorrection,
} from 'coachboard-shared/pose'
import { displayPose } from 'coachboard-shared/poseRefine'
import { repLockouts } from 'coachboard-shared/lockout'
import {
  analysePath,
  pixelsPerMetreFromPlate,
  type RepMetrics,
} from 'coachboard-shared/videoAnalysis'
import {
  defaultVelocityMetric,
  lastRepVelocity,
  liftLabel,
  measuredMvt,
  type VbtLift,
} from 'coachboard-shared/vbt'
import RepTable from '../components/analysis/RepTable'
import PathPlot from '../components/analysis/PathPlot'
import BarSpeedChart from '../components/analysis/BarSpeedChart'
import PathClipButton from '../components/analysis/PathClipButton'
import PathImageButtons from '../components/analysis/PathImageButtons'
import { downloadCsv, repCsv } from '../components/analysis/repCsv'
import { velocityPr } from '../components/analysis/setHistory'
import { useReferenceRep } from '../components/analysis/referenceRep'
import ReferencePanel from '../components/analysis/ReferencePanel'
import JointAngleChart, { angleSeries } from '../components/analysis/JointAngleChart'
import { captionFill, type CaptionField } from '../components/analysis/captionFill'
import { plainKey, useAnalysisKeys } from '../components/analysis/analysisKeys'
import TrackingControls from '../components/analysis/TrackingControls'
import LoadError from '../components/LoadError'
import VelocityPanel, {
  rememberLift,
  rememberedLift,
  type SetContextState,
} from '../components/analysis/VelocityPanel'
import LiftPrompt, { type KnownLift } from '../components/analysis/LiftPrompt'
import {
  useVbtHistory,
  useAthleteMaxes,
  useAthleteMvt,
} from '../components/analysis/useVbtHistory'
import TrainingDayLink, { NO_LINK, type DayLink } from '../components/analysis/TrainingDayLink'
import VelocityTargetLine, { tableTarget, useSetTarget } from '../components/analysis/VelocityTarget'
import { localDay } from 'coachboard-shared/vbtSession'
import { unitOf } from 'coachboard-shared/units'
import { useConfirm } from '../components/ui/confirm-dialog'
import SavedAnalyses from '../components/analysis/SavedAnalyses'
import { num } from '../lib/num'
import { uploadVideo } from '../lib/uploadAnalysisVideo'
import { useUnsavedWork } from '../lib/unsavedWork'

type Phase = 'idle' | 'capturing' | 'tracking' | 'done'

/**
 * The name an estimated max is stored under (BP34): the plain lift name where
 * there is one, so the load hints rank it like a lifted max of that lift (the
 * newest wins) rather than as a variation.
 */
function maxNameFor(lift: VbtLift): string {
  const plain: Partial<Record<VbtLift, string>> = {
    'back-squat': 'Back squat',
    'bench-press': 'Bench press',
    'deadlift-conventional': 'Deadlift',
    'deadlift-sumo': 'Sumo deadlift',
  }
  return plain[lift] ?? liftLabel(lift)
}

/**
 * Below this the numbers stop meaning anything, so no path is shown at all.
 *
 * Reading a frame off a playing video costs enough that roughly one frame in
 * three is missed, so 30 fps footage yields ~18-20 samples per second. That is
 * still several points per velocity window, so the floor sits below it — the
 * gate is here to catch genuinely unusable captures, not normal ones.
 */
const MIN_EFFECTIVE_FPS = 12

/** The tracker's own floor (tracker.core DEFAULTS.minPoints): fewer and it gives up. */
const MIN_SEED_POINTS = 6
const MIN_SURVIVAL = 0.4

export default function VideoAnalysis() {
  const { mediaId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /**
   * Which tracking run is current. Bumped whenever the clip is left or cleared.
   *
   * Aborting a run deliberately KEEPS what it tracked ("stop and keep"), so an
   * abort alone cannot tell "I have seen enough" from "I left this clip". A run
   * cancelled by choosing another video used to finish anyway and draw its path,
   * and offer to save it, over the NEXT video. Each awaited step checks this.
   */
  const runGenRef = useRef(0)
  /** Ends the current run and makes anything it still produces be discarded. */
  const abandonRun = () => {
    runGenRef.current++
    abortRef.current?.abort()
  }
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
  /** A deep link that failed for another reason than the clip being gone. */
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linkAttempt, setLinkAttempt] = useState(0)
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
  const [showAngles, setShowAngles] = useShowAngles()
  const [showMidFoot, setShowMidFoot] = useShowMidFoot()
  const [plateMm, setPlateMm] = usePlateMm()
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
  /** contextNow() as of the last save or update — see contextNow. */
  const [savedContext, setSavedContext] = useState<string | null>(null)
  /**
   * The scale as of the last save. A scale changed after saving is not saved
   * (D50) — the page says so instead, since every number here moves with it.
   */
  const [savedScale, setSavedScale] = useState<string | null>(null)
  const [updatingSaved, setUpdatingSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  // Saving a local clip uploads it in chunks; closing midway loses the save.
  useUnsavedWork('analysis-save', saving)
  /**
   * Who this set belongs to.
   *
   * Was previously taken from the Discord clip alone, so a local file always
   * saved with no athlete — orphaned, invisible to every profile it should have
   * fed, and impossible to attach afterwards. Null means "not chosen yet";
   * 'none' is the coach explicitly saying this is a throwaway look.
   */
  const [athleteChoice, setAthleteChoice] = useState<string | null>(null)
  const [roster, setRoster] = useState<{ id: string; name: string; height_cm: number | null; unit?: string }[]>([])
  const [savedCount, setSavedCount] = useState(0)
  /** The coach's note on the set (BP23): the cue they would give, kept with the analysis. */
  const [note, setNote] = useState('')
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
    abandonRun()
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
    forgetSave()
    setNote('')
    // Leaving the deep link entirely (back to /analysis) means no video at all,
    // so the picker takes over. A locally-imported file has no id and must
    // survive this, hence only clearing when the param is genuinely absent.
    if (!mediaId) setSource(null)
  }, [mediaId])

  // The Discord caption ("180 kg for 2 @8, bänk") fills in what the set was
  // (BP14). Every field started empty although the clip carried the answer.
  // Marked "from caption" until the coach changes it.
  const [fromCaption, setFromCaption] = useState<ReadonlySet<CaptionField>>(new Set())
  useEffect(() => {
    const cap = source?.kind === 'discord' ? source.item.parsedCaption : null
    const fill = captionFill(cap)
    setFromCaption(new Set(Object.keys(fill) as CaptionField[]))
    if (Object.keys(fill).length === 0) return
    setSetContext((c) => ({
      ...c,
      ...(fill.lift ? { lift: fill.lift, metric: null } : {}),
      ...(fill.load != null ? { loadText: String(fill.load) } : {}),
      ...(fill.reps != null ? { repsText: String(fill.reps) } : {}),
      ...(fill.rpe != null ? { calledRpe: fill.rpe } : {}),
    }))
  }, [source])
  /** The panel's changes, dropping the "from caption" mark from whatever the coach changed. */
  const changeSetContext = (next: SetContextState) => {
    setFromCaption((marks) => {
      const kept = new Set(marks)
      if (next.lift !== setContext.lift) kept.delete('lift')
      if (next.loadText !== setContext.loadText) kept.delete('load')
      if (next.repsText !== setContext.repsText) kept.delete('reps')
      if (next.calledRpe !== setContext.calledRpe) kept.delete('rpe')
      return kept.size === marks.size ? marks : kept
    })
    setSetContext(next)
  }

  // The roster, for attaching a local clip to whoever is in it.
  useEffect(() => {
    let cancelled = false
    getList<{ id: string; name: string; height_cm: number | null; unit?: string; archived?: number }>('/api/athletes')
      .then((data) => {
        if (cancelled) return
        setRoster(
          data
            .filter((a) => !a.archived)
            .map((a) => ({ id: a.id, name: a.name, height_cm: a.height_cm ?? null, unit: a.unit })),
        )
      })
      // An empty athlete picker with no reason looked like having no athletes.
      .catch((err) => {
        if (cancelled) return
        setRoster([])
        toast.error(`Could not load your athletes, so a clip cannot be attached to one. ${errorMessage(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [toast])

  // Deep-linked from a video's player dialog: resolve that one and skip the picker.
  useEffect(() => {
    if (!mediaId) return
    let cancelled = false
    setLinkError(null)
    // Only a 404 means the video is gone (BP6). Every failure used to say so,
    // sending a coach to look for a clip that was there all along.
    getJson<DiscordMediaItem>(`/api/discord/media/${encodeURIComponent(mediaId)}`)
      .then((data) => !cancelled && setSource({ kind: 'discord', item: data }))
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) setNotFound(true)
        else setLinkError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [mediaId, linkAttempt])

  // A local file is held as an object URL for as long as it is being analysed.
  // Revoked on swap or unmount, or the bytes stay pinned in memory for the life
  // of the window.
  useEffect(() => {
    if (source?.kind !== 'local') return
    const url = source.url
    return () => URL.revokeObjectURL(url)
  }, [source])

  // A set recorded on the camera screen or sent from the phone brings the
  // athlete and lift picked there (BP41, D103), so saving afterwards is one click.
  useEffect(() => {
    if (source?.kind !== 'local' || !source.preset) return
    const { athleteId, lift } = source.preset
    if (athleteId) setAthleteChoice(athleteId)
    rememberLift(lift)
    setSetContext((c) => ({ ...c, lift, metric: null }))
  }, [source])

  /**
   * The lift, asked first thing for every clip (D126): the plate cannot be
   * clicked until the coach has said which lift it is. A caption's lift is
   * picked out for one click. A lift picked before filming — on the camera
   * screen or the phone, where it is required — is gone by without asking
   * (D127); "Change" still asks, with it picked out.
   */
  const [liftConfirmed, setLiftConfirmed] = useState(false)
  useEffect(() => setLiftConfirmed(source?.kind === 'local' && !!source.preset), [source])
  const knownLift: KnownLift | null = useMemo(() => {
    if (source?.kind === 'local' && source.preset) return { lift: source.preset.lift, from: 'recording' }
    const fromCap = source?.kind === 'discord' ? captionFill(source.item.parsedCaption).lift : undefined
    return fromCap ? { lift: fromCap, from: 'caption' } : null
  }, [source])
  const confirmLift = (lift: VbtLift) => {
    rememberLift(lift)
    // The metric belongs to a lift; a leftover from the last one is silently wrong (see the panel).
    changeSetContext({ ...setContext, lift, metric: lift === setContext.lift ? setContext.metric : null })
    setLiftConfirmed(true)
  }

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
    // The lift first (D126): it decides what the page reads off the set.
    if (!liftConfirmed) {
      toast.info('Pick the lift above the video first.')
      return
    }
    // The click starts a tracking run, and before the analyser has compiled
    // that run plays the clip with nothing consuming its frames.
    if (cvStatus !== 'ready') {
      toast.info('The analyser is still loading — click the bar again in a moment.')
      return
    }
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

  /**
   * What the set was, as it would be saved right now. Compared against what
   * WAS saved, so a change after pressing Save is noticed rather than lost —
   * the fields stay editable, and a load typed after saving used to go nowhere
   * while the page still said "Saved."
   */
  /** A save belongs to one clip: none of it may show on the next one. */
  const forgetSave = () => {
    setSavedId(null)
    setSavedContext(null)
    setSavedScale(null)
    setOfferSave(false)
    setMaxOffer('open')
  }

  /** The estimate on screen, offered as a max after saving (BP34, D60). */
  const [estimateKg, setEstimateKg] = useState<number | null>(null)
  const [maxOffer, setMaxOffer] = useState<'open' | 'saving' | 'done' | 'declined'>('open')
  const recordEstimatedMax = async () => {
    if (!athleteId || estimateKg == null) return
    setMaxOffer('saving')
    try {
      await sendJson('POST', `/api/athletes/${encodeURIComponent(athleteId)}/maxes`, {
        lift_name: maxNameFor(setContext.lift),
        weight: estimateKg,
        estimated: true,
        notes: `Estimated from bar speed (${sourceLabel || 'a saved set'})`,
      })
      setMaxOffer('done')
      toast.success(`Recorded ${estimateKg} ${loadUnit} as an estimated ${liftLabel(setContext.lift).toLowerCase()} max. It is used for load hints, not counted as a PR.`)
    } catch (err) {
      setMaxOffer('open')
      toast.error(`Could not record the max. ${errorMessage(err)}`)
    }
  }

  const scaleNow = () => JSON.stringify(calibration ? { ...calibration, plateMm } : null)

  const contextNow = () =>
    JSON.stringify({
      athleteId,
      lift: reps.length > 0 ? setContext.lift : null,
      loadKg,
      calledRpe: setContext.calledRpe,
      metric: reps.length > 0 ? metric : null,
      notes: note.trim() || null,
    })

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
  // The athlete's unit (S3, D79): the load, the estimate and the offer use it.
  const loadUnit = unitOf(roster.find((a) => a.id === athleteId)?.unit)
  // The training day and row the set was (L2, D67). Follows the clip until the
  // coach picks; a new clip or another athlete starts over.
  const [linkChoice, setLinkChoice] = useState<DayLink | null>(null)
  const [dayLink, setDayLink] = useState<DayLink>(NO_LINK)
  useEffect(() => { setLinkChoice(null) }, [athleteId, source])
  const liftedDay = source?.kind === 'discord' ? localDay(source.item.postedAt) : localDay(new Date().toISOString())
  const metric = setContext.metric ?? defaultVelocityMetric(setContext.lift)
  // The linked row's velocity target, and the set against it (BP39, D74).
  const setTarget = useSetTarget(dayLink.velocity, reps, metric, pixelsPerMetre !== null)
  const { anchors: savedAnchors, points: savedPoints, rows: historyRows } = useVbtHistory(
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
  // The athlete's reference rep for this lift (BP28), drawn over this set.
  const reference = useReferenceRep(athleteId, setContext.lift === 'other' ? null : setContext.lift)

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

    abandonRun()
    const gen = runGenRef.current
    const stale = () => gen !== runGenRef.current
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
    // The skeleton is not touched: it was read from the whole clip on its own
    // (D117), and tracking the bar changes nothing about the body.

    try {
      // Frames are read off the playing video, so the coach watches the lift
      // with the dot on the bar. An every-frame decoder was tried (BP21) and
      // taken back out (D62): it made the video lag behind the dot.
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
        },
      )

      // The coach left this clip mid-run: nothing below belongs on screen now.
      if (stale()) {
        streamRef.current?.cancel()
        return
      }

      if (!streamRef.current) {
        toast.error('No frames could be read from that range.')
        setPhase('idle')
        return
      }

      // Note: an aborted run is NOT discarded. Capture stops early but the
      // frames already tracked are perfectly good, so stopping is "I have seen
      // enough reps" rather than "throw it away" — which matters on a long clip
      // where the coach only cares about the first set. Leaving the clip is
      // different, and is caught by `stale` above and below.
      const result = await streamRef.current.finish()
      if (stale()) return

      const q = result.quality
      // Too few corners under the circle to follow. The track is lost on its
      // first frame, so capture stops almost at once — and this used to be
      // reported as "not enough frames, widen the range", which sends the coach
      // to fix the wrong thing.
      if (q.seededPoints < MIN_SEED_POINTS) {
        toast.error(
          'There is nothing to follow at that spot. Click the middle of a plate, where the edge and lettering give the tracker detail, or enlarge the circle with +.',
        )
        setSamples(null)
        setPhase('idle')
        return
      }
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
      streamRef.current?.cancel()
      if (stale()) return
      if (!controller.signal.aborted) {
        toast.error(err instanceof Error ? err.message : 'Tracking failed')
      }
      setSamples(null)
      setPhase('idle')
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

      const saved = await sendJson<{ id: string }>('POST', '/api/analysis', {
        mediaId: source?.kind === 'discord' ? source.item.id : null,
        athleteId,
        sourceLabel: sourceLabel,
        track: samples,
        calibration: calibration ? { ...calibration, plateDiameterMm: plateMm } : null,
        metrics: reps,
        notes: note.trim() || null,
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
        workoutId: athleteId ? dayLink.workoutId : null,
        exerciseId: athleteId && dayLink.workoutId ? dayLink.exerciseId : null,
      })
      setSavedId(saved.id)
      setSavedContext(contextNow())
      setSavedScale(scaleNow())
      setOfferSave(false)
      setSavedCount((n) => n + 1)
      toast.success('Analysis saved')
      // The fastest set at this load so far (BP35, D54), against the athlete's
      // earlier sets as they stood before this save.
      if (athleteId && reps.length > 0 && loadKg != null) {
        const pr = velocityPr(historyRows, { id: saved.id, lift: setContext.lift, loadKg, createdAt: new Date().toISOString(), metrics: reps }, metric)
        if (pr?.kind === 'pr') {
          toast.success(`Velocity PR — the fastest ${loadKg} ${loadUnit} ${liftLabel(setContext.lift).toLowerCase()} so far: ${pr.best.toFixed(2)} m/s (was ${pr.previous.toFixed(2)}).`)
        }
      }

      // The skeleton, if the clip has been read; if it is still being read it
      // goes up the moment that finishes (see the reading effect).
      await storePose(saved.id)

      // Last, because it can open a dialog and wait on the coach. Everything
      // above is a write that should already have landed by the time a modal
      // takes over the window.
      await offerMeasuredMvt()
    } catch (err) {
      // The reason used to be dropped, leaving the coach nothing to act on (BP6).
      toast.error(`Could not save that analysis. ${errorMessage(err)}`)
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

  /** Writes a post-save change to the lift, load, RPE or athlete onto the saved set. */
  const updateSavedContext = async () => {
    if (!savedId) return
    setUpdatingSaved(true)
    try {
      const res = await fetch(`/api/analysis/${savedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: contextNow(),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `the server said ${res.status}`)
      }
      setSavedContext(contextNow())
      setSavedCount((n) => n + 1)
      toast.success('Saved set updated')
    } catch (err) {
      toast.error(`Could not update the saved set — ${err instanceof Error ? err.message : 'unknown error'}.`)
    } finally {
      setUpdatingSaved(false)
    }
  }

  const reset = () => {
    abandonRun()
    livePathRef.current = []
    // Clear is "start this clip over", so the corrections go too. The skeleton
    // read from the clip stays: reading it again would give the same thing.
    poseCorrectionsRef.current = []
    setPoseCorrections([])
    redrawPose()
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
    setLinkError(null)
    setNote('')
    forgetSave()
    if (mediaId) navigate('/analysis', { replace: true })
  }

  /**
   * "Next clip" after saving (BP19, D48): the next one down the picker's list
   * — older — that has no saved analysis yet, so an inbox can be worked
   * through without going back to the picker each time.
   */
  const [findingNext, setFindingNext] = useState(false)
  const openNextClip = async () => {
    if (source?.kind !== 'discord') return
    const currentId = source.item.id
    setFindingNext(true)
    try {
      let seen = false
      for (let offset = 0; ; ) {
        const page = await getJson<{ items: DiscordMediaItem[]; total: number }>(`/api/discord/media?filter=all&limit=200&offset=${offset}`)
        for (const m of page.items) {
          if (seen && m.isVideo && m.playable && m.analysisCount === 0) {
            navigate(`/analysis/${m.id}`)
            return
          }
          if (m.id === currentId) seen = true
        }
        offset += page.items.length
        if (page.items.length === 0 || offset >= page.total) break
      }
      toast.info('No older clip is waiting for an analysis.')
    } catch (err) {
      toast.error(`Could not find the next clip. ${errorMessage(err)}`)
    } finally {
      setFindingNext(false)
    }
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
   * The displayed copy of the clip's skeleton (legs rebuilt, jitter-filtered),
   * memoised on the source array.
   *
   * `smooth` alone costs 19 ms for a 300-frame track and 55 ms for 900 —
   * measured — so running it per redraw would eat most of a core at thirty
   * redraws a second. The skeleton is read whole before it is shown (D117) and
   * replaced, never mutated, so identity is a sound cache key and every redraw
   * after the first is a lookup.
   */
  const poseSmoothCache = useRef<{ source: PoseFrame[]; result: PoseFrame[] } | null>(null)
  const smoothedPose = (measured: PoseFrame[]): PoseFrame[] => {
    if (measured.length < 3) return measured
    if (poseSmoothCache.current?.source === measured) return poseSmoothCache.current.result
    const result = displayPose(measured)
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

  // ── The skeleton, read from the whole clip first (D117) ─────────────────
  /**
   * Where reading the clip's skeleton stands. `progress` is 0-1 while reading.
   *
   * The skeleton used to be read live — the frame on screen, and the frames the
   * tracker pulled — with the model carrying its search region frame to frame.
   * Filmed from the side, a loaded bar hides the legs and that region drifted
   * onto the plate. Now the whole clip is read first, every frame on its own,
   * and the clip as a whole puts the hidden legs right (poseRefine.ts); the
   * coach waits a little and then sees the best limbs it allows.
   */
  const [poseRead, setPoseRead] = useState<{ status: 'idle' | 'reading' | 'done' | 'error'; progress: number }>({ status: 'idle', progress: 0 })
  /** The clip whose skeleton poseMeasuredRef holds in full. */
  const poseReadFor = useRef<string | null>(null)
  /** The analysis the skeleton has been stored against, so it goes up once. */
  const poseStoredFor = useRef<string | null>(null)
  const videoSrcRef = useRef(videoSrc)
  videoSrcRef.current = videoSrc
  const savedIdRef = useRef(savedId)
  savedIdRef.current = savedId

  /**
   * Stores the clip's skeleton against a saved analysis, once it has been read.
   *
   * The MEASUREMENT is stored, never the displayed or corrected copy — the
   * whole point of keeping them in layers is that re-reading cannot destroy a
   * fix, and that only holds if the fix was never baked into what the model
   * said. In its own request, and failing it must not cost the coach the bar
   * path, which is the actual measurement.
   */
  const storePose = async (id: string) => {
    if (poseStoredFor.current === id) return
    if (poseReadFor.current !== videoSrcRef.current || poseMeasuredRef.current.length === 0) return
    poseStoredFor.current = id
    try {
      await savePose(id, poseMeasuredRef.current)
      for (const c of correctionsAtTimes(poseMeasuredRef.current, poseCorrectionsRef.current)) {
        await putCorrection(id, c)
      }
    } catch {
      poseStoredFor.current = null
      toast.error('The analysis was saved, but the skeleton could not be.')
    }
  }

  useEffect(() => {
    // A different clip, or none: what was read belongs to the last one.
    if (poseReadFor.current !== videoSrc) {
      poseReadFor.current = null
      poseStoredFor.current = null
      poseMeasuredRef.current = []
      poseRef.current = []
      setPoseRead({ status: 'idle', progress: 0 })
    }
    const video = videoRef.current
    if (!showPose || !source || !videoSrc || !video || poseReadFor.current === videoSrc) return

    const controller = new AbortController()
    const forSrc = videoSrc
    const start = async () => {
      if (!video.videoWidth) {
        await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }))
      }
      if (controller.signal.aborted || !video.videoWidth) return
      setPoseRead({ status: 'reading', progress: 0 })
      let lastShown = 0
      try {
        const frames = await readClipPose({
          source: source.kind === 'local' ? { blob: source.file } : { url: forSrc },
          src: forSrc,
          duration: video.duration,
          // Each frame on its own (IMAGE): nothing carried from one to the next.
          open: () => pose.open({ videoWidth: video.videoWidth, videoHeight: video.videoHeight, mode: 'IMAGE' }),
          signal: controller.signal,
          // Tracking reads the playing video and has a frame-rate floor; it gets the CPU.
          hold: () => busyRef.current,
          onProgress: (fraction) => {
            const now = performance.now()
            if (now - lastShown > 250) {
              lastShown = now
              setPoseRead({ status: 'reading', progress: fraction })
            }
          },
        })
        if (controller.signal.aborted) return
        poseMeasuredRef.current = frames
        poseReadFor.current = forSrc
        redrawPose()
        setPoseRead({ status: 'done', progress: 1 })
        // Saved while it was still being read: it goes up now.
        if (savedIdRef.current) void storePose(savedIdRef.current)
      } catch {
        if (controller.signal.aborted) return
        setPoseRead({ status: 'error', progress: 0 })
      }
    }
    void start()
    return () => controller.abort()
    // Deliberately not depending on pose, redrawPose or storePose: re-running
    // this would throw away a read in progress on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPose, source, videoSrc])

  /**
   * Joint angles against the bar on this page too (BP13), once the bar is
   * tracked and the clip's skeleton read. poseRef is read rather than depended
   * on — a correction is what changes it, and poseCorrections is the state that
   * says so; poseRead says the skeleton itself arrived.
   */
  const poseSeries = useMemo(() => {
    if (busy || !showPose || !samples || samples.length < 2) return null
    const frames = poseRef.current
    if (frames.length < 2) return null
    return angleSeries(frames, samples, pixelsPerMetre)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, showPose, samples, poseCorrections, pixelsPerMetre, poseRead.status])

  // ── Keys (BP15, D37) ────────────────────────────────────────────────────
  // The stage takes Space, ← / →, F and 1–9; these are the page's own.
  // Above the early returns, as every hook must be; it works out what it needs
  // from state rather than from values declared further down.
  const setRangeStart = () =>
    setRange((r) => ({ from: currentTime, to: Math.max(currentTime + 0.2, r?.to ?? duration) }))
  const setRangeEnd = () =>
    setRange((r) => ({ from: Math.min(r?.from ?? 0, currentTime - 0.2), to: currentTime }))
  const toggleCalibrate = () => {
    setMode((m) => (m === 'calibrate' ? 'seed' : 'calibrate'))
    setAwaitingSecondPoint(false)
  }
  useAnalysisKeys(!!videoSrc, (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      if (!samples || saving || updatingSaved) return true
      if (!savedId) void saveAnalysis()
      else if (savedContext !== contextNow()) void updateSavedContext()
      return true
    }
    if (busy) return false
    if (plainKey(e, 'i')) { setRangeStart(); return true }
    if (plainKey(e, 'o')) { setRangeEnd(); return true }
    if (plainKey(e, 't')) {
      if (!!seed && cvStatus === 'ready' && !!range) retrack()
      return true
    }
    if (plainKey(e, 's')) { toggleCalibrate(); return true }
    if (plainKey(e, 'p')) {
      setMode((m) => (m === 'draw' ? 'seed' : 'draw'))
      setAwaitingSecondPoint(false)
      return true
    }
    return false
  })

  if (linkError) {
    return (
      <div className="space-y-4 p-8">
        <LoadError what="that video" message={linkError} onRetry={() => setLinkAttempt((n) => n + 1)} />
        <Button variant="outline" onClick={chooseAnother}>Choose another video</Button>
      </div>
    )
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
            {/* Before a clip is picked, not after tracking (BP27): every number
                on the page assumes this, and it is the moment the coach can
                still pass it on to the athlete. */}
            <section className="rounded-md border bg-muted/40 p-3 text-sm" aria-label="Filming tips">
              <p className="flex items-center gap-2 font-medium">
                <Smartphone className="h-4 w-4 text-muted-foreground" /> For numbers you can trust, the clip needs
              </p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-9 text-muted-foreground">
                <li>the camera side-on to the bar, level with it — the plate a circle, not an oval</li>
                <li>the whole plate in frame for the whole set, with nothing passing in front of it</li>
                <li>the phone held still, on a stand or something solid — a moving camera moves the path</li>
              </ul>
            </section>
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

  // The top before each rep: 1–9 and a click on a rep's number go there, so the whole rep plays.
  const repTops = samples?.length && trackedReps.length ? repWindows(trackedReps, samples[0].t).map((w) => w.from) : []
  const canTrack = !!seed && cvStatus === 'ready' && !busy && !!range

  return (
    <div className="space-y-4 p-6">
      {/* Wraps, like the saved page's: the actions outgrow one line on a narrow window. */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={chooseAnother} title="Choose another video">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-[1_1_16rem]">
          <h1 className="text-lg font-semibold">Bar path analysis</h1>
          <p className="truncate text-sm text-muted-foreground">{sourceLabel}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* The frame on screen as an image for the athlete (BP24). */}
          {samples && samples.length > 1 && !busy && source && (
            <PathImageButtons
              videoRef={videoRef}
              track={samples}
              reps={reps}
              metric={metric}
              strokes={strokes}
              color={color}
              title={[
                reps.length > 0 ? liftLabel(setContext.lift) : 'Bar path',
                loadKg != null ? `${loadKg} ${loadUnit}` : null,
                roster.find((a) => a.id === athleteId)?.name ?? (source.kind === 'discord' ? source.item.athleteName : null),
                source.kind === 'discord' ? source.item.postedAt.slice(0, 10) : null,
              ].filter(Boolean).join(' · ')}
              note={note.trim() || null}
              name={source.kind === 'local' ? source.name : sourceLabel}
            />
          )}
          {/* The clip with the path drawn in (BP25), once there is a path. */}
          {samples && samples.length > 1 && !busy && source && (
            <PathClipButton
              source={source.kind === 'local' ? source.file : `/api/discord/media/${source.item.id}/file`}
              track={samples}
              reps={trackedReps}
              strokes={strokes}
              color={color}
              name={source.kind === 'local' ? source.name : sourceLabel}
            />
          )}
          <Button variant="outline" size="sm" onClick={chooseAnother} disabled={busy}>
            Choose another video
          </Button>
        </div>
      </div>

      {/* The lift, first thing (D126). */}
      {videoSrc && !liftConfirmed && <LiftPrompt known={knownLift} onPick={confirmLift} />}
      {videoSrc && liftConfirmed && (
        <p className="text-sm text-muted-foreground">
          Lift: <span className="font-medium text-foreground">{liftLabel(setContext.lift)}</span>
          <Button size="sm" variant="ghost" className="ml-1 h-7 px-2" onClick={() => setLiftConfirmed(false)}>Change</Button>
        </p>
      )}
      {videoSrc && (
        // The reps' paths beside the video once there are any (BP10), laid
        // over each other; it was never on this page before.
        <div className={samples && trackedReps.length > 0 ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]' : ''}>
        <AnalysisStage
          src={videoSrc}
          videoRef={videoRef}
          seed={seed}
          samples={samples}
          livePathRef={livePathRef}
          poseRef={poseRef}
          showPose={showPose}
          showAngles={showAngles}
          showMidFoot={showMidFoot && MID_FOOT_LIFTS.includes(setContext.lift)}
          poseLift={setContext.lift}
          ghost={reference.shape && pixelsPerMetre ? { path: reference.shape.path, pixelsPerMetre } : null}
          onCorrectLandmark={correctPoseLandmark}
          onPlaceSeed={placeSeed}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={setCurrentTime}
          disabled={busy}
          color={color}
          mode={mode}
          calibration={calibration}
          onCalibratePoint={addCalibrationPoint}
          onCalibrationChange={(line) => {
            setCalibration(line)
            setAwaitingSecondPoint(false)
          }}
          strokes={strokes}
          onDrawStroke={(s) => setStrokes((prev) => [...prev, s])}
          keyboard
          repStarts={repTops}
          reps={trackedReps}
          trackRange={range}
        />
        {samples && trackedReps.length > 0 && (
          <PathPlot track={samples} color={color} pixelsPerMetre={pixelsPerMetre} reps={trackedReps} currentTime={currentTime} height={320} />
        )}
        </div>
      )}

      {/* The bar's speed through the set and each rep's sticking point (BP11). */}
      {samples && samples.length > 1 && !busy && (
        <div className="space-y-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">Bar speed</h2>
          <BarSpeedChart track={samples} reps={trackedReps} pixelsPerMetre={pixelsPerMetre} currentTime={currentTime} />
        </div>
      )}

      {/* What the body was doing when the bar slowed (BP13) — it used to be on
          the saved page only. */}
      {poseSeries && poseSeries.length > 1 && (
        <div className="space-y-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">Joint angles against the bar</h2>
          <JointAngleChart series={poseSeries} calibrated={pixelsPerMetre !== null} />
        </div>
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
            <TrackingControls
              mode={mode}
              onModeChange={(next) => {
                setMode(next)
                setAwaitingSecondPoint(false)
              }}
              onToggleCalibrate={toggleCalibrate}
              awaitingSecondPoint={awaitingSecondPoint}
              hasSeed={!!seed}
              hasSamples={!!samples}
              onResizeSeed={resizeSeed}
              busy={busy}
              showPose={showPose}
              onShowPose={setShowPose}
              poseStatus={pose.status}
              poseError={pose.error}
              poseReading={poseRead.status === 'reading' ? poseRead.progress : null}
              poseReadFailed={poseRead.status === 'error'}
              correctionsCount={poseCorrections.length}
              showAngles={showAngles}
              onShowAngles={setShowAngles}
              midFootLift={MID_FOOT_LIFTS.includes(setContext.lift)}
              showMidFoot={showMidFoot}
              onShowMidFoot={setShowMidFoot}
              color={color}
              onColor={setColor}
              range={range}
              duration={duration}
              onSetStart={setRangeStart}
              onSetEnd={setRangeEnd}
              plateMm={plateMm}
              onPlateMm={setPlateMm}
              pixelsPerMetre={pixelsPerMetre}
              calibrationPx={calibrationPx}
              progress={progress}
              canTrack={canTrack}
              onTrack={retrack}
              onCancel={cancelTracking}
              onClear={reset}
              strokes={strokes}
              onStrokesChange={setStrokes}
              quality={quality}
              pathPoints={samples ? samples.length : null}
            />

            {/* The coach's cue for the set (BP23). Kept with the analysis and
                shown on the saved page and in the lists. Changing it after
                saving offers "Update saved set", like the lift and load. */}
            {samples && (
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Note on this set</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="The cue for the athlete, e.g. drive the hips through, keep the bar over mid-foot"
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                />
              </label>
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
                        ` The lift and ${loadKg} ${loadUnit} go with it, so the athlete's velocity profile builds up.`}
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

                <TrainingDayLink
                  athleteId={athleteId}
                  day={liftedDay}
                  lift={reps.length > 0 ? setContext.lift : null}
                  loadKg={loadKg}
                  preferredWorkoutId={source?.kind === 'discord' ? source.item.workoutId : null}
                  choice={linkChoice}
                  onChoose={setLinkChoice}
                  onResolved={setDayLink}
                />

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

            {savedId &&
              (savedContext !== null && savedContext !== contextNow() ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
                  <span>The lift, load, RPE, athlete or note changed since you saved.</span>
                  <Button size="sm" variant="outline" onClick={updateSavedContext} disabled={updatingSaved}>
                    {updatingSaved ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Update saved set
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Check className="h-4 w-4 text-success" /> Saved.
                  {source?.kind === 'discord' && (
                    <Button size="sm" variant="outline" onClick={openNextClip} disabled={findingNext}>
                      {findingNext ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                      Next clip
                    </Button>
                  )}
                </div>
              ))}
            {/* The estimate as a max (BP34, D60): only when the coach confirms,
                stored marked "estimated" — used for load hints and generated
                blocks, never as a PR, never to calibrate another estimate. */}
            {savedId && athleteId && estimateKg != null && maxOffer !== 'done' && maxOffer !== 'declined' && reps.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <span>
                  Record <span className="num font-medium">{estimateKg} {loadUnit}</span> as an estimated {liftLabel(setContext.lift).toLowerCase()} max
                  {athleteName ? ` for ${athleteName}` : ''}?
                </span>
                <Button size="sm" variant="outline" onClick={recordEstimatedMax} disabled={maxOffer === 'saving'}>
                  {maxOffer === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Record
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMaxOffer('declined')}>Not now</Button>
              </div>
            )}
            {savedId && savedScale !== null && savedScale !== scaleNow() && (
              <p className="text-sm text-warning">
                The scale changed since you saved. The saved set keeps the scale it was saved with; the
                numbers on this page use the new one.
              </p>
            )}

            {samples && trackedReps.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">
                    Concentric velocity — {reps.length} {reps.length === 1 ? 'rep' : 'reps'}
                    {excludedReps.size > 0 && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({excludedReps.size} struck off)
                      </span>
                    )}
                  </h2>
                  {/* The rep table as a file (BP42). */}
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Save the rep table as a CSV file, for your own sheets"
                    onClick={() => downloadCsv(repCsv(trackedReps, { track: samples, pixelsPerMetre, excluded: excludedReps }), sourceLabel || 'lift')}
                  >
                    <FileDown className="h-4 w-4" /> CSV
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  A cycle that was not a rep — a re-rack, a failed attempt, a bounce in the walkout —
                  skews everything measured from the set. Strike it off and every number below is
                  recalculated without it.
                </p>
                <RepTable
                  reps={trackedReps}
                  lift={setContext.lift}
                  metric={metric}
                  calibrated={pixelsPerMetre !== null}
                  anchors={anchors}
                  track={samples}
                  pixelsPerMetre={pixelsPerMetre}
                  excluded={excludedReps}
                  onToggle={toggleRep}
                  target={tableTarget(setTarget)}
                  midFoot={busy ? null : midFootByRep(setContext.lift, poseRef.current, samples, trackedReps, pixelsPerMetre)}
                  lockout={busy || !showPose ? null : repLockouts(poseRef.current, trackedReps, setContext.lift)}
                  onJump={(index) => {
                    const at = repTops[trackedReps.findIndex((r) => r.index === index)]
                    const v = videoRef.current
                    if (at == null || !v) return
                    v.pause()
                    v.currentTime = at
                  }}
                />
                {reference.shape && (
                  <ReferencePanel
                    shape={reference.shape}
                    reps={reps}
                    track={samples}
                    pixelsPerMetre={pixelsPerMetre}
                    loadKg={loadKg}
                    metric={metric}
                    athleteName={roster.find((a) => a.id === athleteId)?.name ?? null}
                    unit={loadUnit}
                  />
                )}
              </div>
            )}

            {/* Velocity-based readouts live in their own panel: they need the
                lift and load, which the tracker cannot know, and they are
                interpretation rather than measurement. */}
            {samples && reps.length > 0 && (
              <VelocityTargetLine setTarget={setTarget} rowName={dayLink.exerciseName ?? null} calibrated={pixelsPerMetre !== null} />
            )}
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
                onChange={changeSetContext}
                fromCaption={fromCaption}
                onSetScale={startCalibration}
                onEstimate={setEstimateKg}
                unit={loadUnit}
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
