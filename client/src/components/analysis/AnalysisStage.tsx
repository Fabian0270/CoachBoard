import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize, Minimize } from 'lucide-react'
import { pictureRect } from 'coachboard-shared/videoAnalysis'
import {
  POSE_BONES,
  frameIndexAt,
  isVisible,
  type PoseFrame,
} from 'coachboard-shared/pose'
import { isDrawable, simplify, type Point, type Stroke } from './annotations'
import type { Sample } from './tracker.core'

/**
 * Height of the browser's own control bar along the bottom of the video.
 *
 * A rough figure, and unavoidably so: the bar lives in a shadow tree nothing can
 * measure, and Chromium both draws a taller one in fullscreen and stacks it into
 * two rows when the clip is narrow enough to overflow its controls. Two things
 * need the number — the click layer stops above it so play and scrub keep
 * working, and a double-click inside it is left to the controls rather than
 * taken as a fullscreen gesture — so it is one constant rather than two guesses.
 */
const CONTROL_BAR_PX = 48
const CONTROL_BAR_FULLSCREEN_PX = 80

/**
 * How far a pointer must travel, in SCREEN pixels, before a press on a joint
 * counts as dragging it rather than as a click aimed at what is underneath.
 */
const DRAG_SLOP_PX = 4

/**
 * How far a pose frame may sit from the playhead and still be drawn, in seconds.
 *
 * Generous next to the preview's own refresh rate so the skeleton does not
 * flicker between frames, tight enough that a pose measured somewhere else in
 * the lift is never painted over the lifter as if it were this moment.
 */
const POSE_MAX_STALE_S = 0.4

/** A point in ORIGINAL video pixels. Everything the coach sees is display
 *  pixels, but every stored coordinate is video pixels so it survives resizing
 *  the window, and so the track means the same thing at any zoom. */
export interface SeedPoint {
  x: number
  y: number
  /** Half-width of the square the tracker seeds features in. */
  radius: number
}

/**
 * Two points spanning something of known real-world size, in video pixels.
 *
 * Deliberately separate from the seed circle. The two want opposite things: the
 * tracker needs a GENEROUS box so it can find enough corners to follow, while a
 * scale reference needs to match the plate's edge EXACTLY. Sizing one circle to
 * do both starves the tracker the moment the coach makes it accurate — which is
 * exactly what happened when they were the same control.
 */
export interface CalibrationLine {
  a: { x: number; y: number }
  b: { x: number; y: number }
}

/** Which control the next click on the video drives. */
export type StageMode = 'seed' | 'calibrate' | 'draw'

interface Props {
  src: string
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  seed: SeedPoint | null
  /** Video-pixel path, or null before tracking has run. */
  samples: Sample[] | null
  /**
   * Path being built right now, read straight from a ref rather than state.
   *
   * Live tracking produces a point every frame, and pushing each one through
   * React re-rendered the whole page — and re-ran the metrics over the whole
   * growing array — thirty times a second, which starved the capture loop badly
   * enough to halve the effective frame rate. The overlay already redraws every
   * animation frame, so it can just read the latest array itself.
   */
  livePathRef?: React.MutableRefObject<Sample[]>
  onPlaceSeed: (point: { x: number; y: number }) => void
  onLoadedMetadata: (video: HTMLVideoElement) => void
  onTimeUpdate: (time: number) => void
  disabled?: boolean
  /** Overlay colour, chosen by the coach — see trackerColor.ts. */
  color: string
  mode: StageMode
  calibration: CalibrationLine | null
  /** Called with each click while in 'calibrate' mode. */
  onCalibratePoint: (point: { x: number; y: number }) => void
  /** Freehand marks over the lift, in video pixels. See annotations.ts. */
  strokes?: Stroke[]
  /** Called with the finished stroke when the pointer lifts in 'draw' mode. */
  onDrawStroke?: (stroke: Stroke) => void
  /**
   * Pose frames to draw a skeleton from, in video pixels (Feature 11e).
   *
   * A ref for the same reason `livePathRef` is one: inference produces a frame
   * roughly every 33 ms and pushing each through React re-rendered the page and
   * starved the capture loop. The overlay already redraws every animation frame,
   * so it reads the latest array itself.
   */
  poseRef?: React.MutableRefObject<PoseFrame[]>
  /** Whether to draw the skeleton at all. Off is the default. */
  showPose?: boolean
  /**
   * Called when the coach drags a joint to where it should have been (11e-5).
   *
   * Its presence is what makes the skeleton draggable at all — the live tracking
   * page passes nothing, because a track being built is not something to edit.
   */
  onCorrectLandmark?: (frameIndex: number, landmark: number, x: number, y: number) => void
}

/**
 * The video with a drawing surface over it.
 *
 * A real <video> is kept underneath rather than painting frames into a canvas:
 * that keeps native decoding, seeking and playback, and avoids the blank-frame
 * behaviour drawImage shows on some Windows GPU/driver combinations. The canvas
 * only ever holds the overlay.
 */
export default function AnalysisStage({
  src,
  videoRef,
  seed,
  samples,
  livePathRef,
  onPlaceSeed,
  onLoadedMetadata,
  onTimeUpdate,
  disabled,
  color,
  mode,
  calibration,
  onCalibratePoint,
  strokes,
  onDrawStroke,
  poseRef,
  showPose,
  onCorrectLandmark,
}: Props) {
  /**
   * The joint under the pointer, and whether it has actually been dragged yet.
   *
   * `moved` is what keeps correcting from stealing the click that places a
   * tracking point. On the live page a click on the video seeds the tracker, and
   * the plate a coach aims at can sit within grabbing distance of a wrist — so a
   * press that never moves falls through as a click, and only a real drag is
   * treated as a correction.
   */
  const draggingRef = useRef<{
    frameIndex: number
    landmark: number
    from: Point
    moved: boolean
  } | null>(null)
  /** Set on release, so the click that follows a drag is not read as play/pause. */
  const justDraggedRef = useRef(false)
  /** Whether this stage lets the coach move a joint at all — see onCorrectLandmark. */
  const correcting = !!onCorrectLandmark && !!showPose
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  /**
   * The element the overlay is positioned INSIDE. Only its origin is used —
   * every size comes from the video's own rect, measured each frame. See draw().
   */
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** The click and draw target, laid over the video by the draw loop. */
  const layerRef = useRef<HTMLDivElement | null>(null)
  /** mediaTime of the frame the compositor last put on screen. */
  const presentedRef = useRef<number | null>(null)
  /**
   * The stroke being drawn right now, in a ref rather than state.
   *
   * A pointer emits a point per animation frame; routing each one through React
   * would re-render the page — and re-run every derived metric on it — for a
   * scribble. The overlay already redraws every frame, so it reads the array
   * itself. Exactly the reasoning behind livePathRef during tracking.
   */
  const drawingRef = useRef<Point[] | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

  const bar = fullscreen ? CONTROL_BAR_FULLSCREEN_PX : CONTROL_BAR_PX

  /**
   * Follows the frames actually being shown, so the overlay can be drawn
   * against them rather than against the playback clock.
   *
   * A paused video presents no frames and so never fires this — which is fine
   * and is why the draw falls back to currentTime: the two agree while nothing
   * is moving. Seeking resets it on `seeked`, or the dot would sit on the frame
   * before the seek until playback resumed.
   */
  useEffect(() => {
    const video = videoRef.current
    const rvfc = (
      video as (HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
      }) | null
    )?.requestVideoFrameCallback
    if (!video || typeof rvfc !== 'function') return

    let stopped = false
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (stopped) return
      presentedRef.current = meta.mediaTime
      rvfc.call(video, onFrame)
    }
    rvfc.call(video, onFrame)

    const clear = () => {
      presentedRef.current = null
    }
    video.addEventListener('seeking', clear)
    return () => {
      stopped = true
      video.removeEventListener('seeking', clear)
    }
  }, [videoRef, src])

  /**
   * The real Fullscreen API, not a fixed-position stand-in.
   *
   * A `position: fixed` overlay would still sit inside Layout's
   * `h-screen overflow-hidden` root and under the sidebar; only the top layer
   * escapes both. Deliberately NOT gated on `disabled`, or a saved analysis —
   * which is always disabled — could never be viewed fullscreen, and that is
   * the main place a coach wants it.
   */
  const toggleFullscreen = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void wrap.requestFullscreen().catch(() => {})
  }, [])

  // Escape and the browser's own exit both bypass our handler, so the flag
  // follows the document rather than our own call. Nothing tries to correct a
  // fullscreen VIDEO here: every way of doing that was measured and none of them
  // renders — see the note in index.css, which is why its button is hidden.
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  /**
   * Whether a pointer is over the browser's control bar rather than the lift.
   *
   * A double-click on play/pause or the scrubber is aimed at the controls, and
   * turning it into a fullscreen toggle made the bar hostile to use.
   */
  const inControlBar = (e: { clientX: number; clientY: number }) => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return false
    return (
      e.clientY > box.bottom - bar &&
      e.clientY <= box.bottom &&
      e.clientX >= box.left &&
      e.clientX <= box.right
    )
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || !video.videoWidth) return

    const rect = video.getBoundingClientRect()
    const box = boxRef.current?.getBoundingClientRect() ?? rect

    // EVERYTHING FOLLOWS THE VIDEO'S OWN RECTANGLE, measured every frame.
    //
    // Not the wrapper, and not the box that contains it. When the browser's own
    // fullscreen button is used, the video stays on the fullscreen stack under
    // our wrapper, so it keeps matching :fullscreen and the UA styles it
    // `position: fixed; width: 100%; height: 100%`. That takes it out of flow —
    // the box around it collapses to ZERO height, and a canvas sized from the
    // box is zero pixels tall, which is exactly how the bar path vanished the
    // moment a coach went fullscreen. Double-clicking produces the opposite
    // geometry, with the video laid out by our own classes.
    //
    // The video's rect is right in both, so it is the only thing measured. The
    // offsets below place the overlay back over it, whatever its box is doing.
    const offsetX = rect.left - box.left
    const offsetY = rect.top - box.top

    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width)
      canvas.height = Math.round(rect.height)
    }
    canvas.style.left = `${offsetX}px`
    canvas.style.top = `${offsetY}px`

    // The click and draw target rides along, stopping short of the browser's
    // control bar so play and scrub keep working.
    const layer = layerRef.current
    if (layer) {
      layer.style.left = `${offsetX}px`
      layer.style.top = `${offsetY}px`
      layer.style.width = `${rect.width}px`
      layer.style.height = `${Math.max(0, rect.height - bar)}px`
    }

    // Where the picture sits inside the video: object-fit contain letterboxes it
    // when the aspect ratios differ, which fullscreen makes the normal case.
    const picture = pictureRect(rect.width, rect.height, video.videoWidth, video.videoHeight)
    const { scale } = picture
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Origin at the picture's top-left, so every `x * scale` below stays
    // correct without threading the offset through each one.
    ctx.save()
    // Origin at the picture's top-left. The canvas is already over the video, so
    // only the letterbox offset remains.
    ctx.translate(picture.left, picture.top)

    // Freehand marks first, so the bar path and its dot stay readable on top of
    // whatever the coach has drawn.
    const penStrokes = drawingRef.current
      ? [...(strokes ?? []), { color, points: drawingRef.current }]
      : (strokes ?? [])
    for (const stroke of penStrokes) {
      if (stroke.points.length < 2) continue
      const trace = () => {
        ctx.beginPath()
        stroke.points.forEach((p, i) =>
          i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale),
        )
        ctx.stroke()
      }
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      // Same dark casing as the bar path: gym footage contains something every
      // colour disappears into somewhere.
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.lineWidth = 6
      trace()
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = 3.5
      trace()
    }

    // Which frame the compositor has actually PRESENTED, not where the playback
    // clock has got to. The clock runs ahead, which made the bar-path dot lead
    // the bar by a frame or two; a skeleton off by the same amount reads as the
    // model being wrong rather than early, so both use this one number.
    const playhead = presentedRef.current ?? video.currentTime

    // The skeleton, under the bar path and over the pen. It is context for the
    // measurement, not the measurement — so nothing it draws is allowed to
    // obscure the path or its dot.
    const poseFrames = showPose ? poseRef?.current : undefined
    if (poseFrames?.length) {
      // Binary search, not the linear reduce the marker below uses. That one
      // walks a few hundred path points; this would walk 33 landmarks x N frames
      // on every animation frame.
      const nearest = poseFrames[frameIndexAt(poseFrames, playhead)]
      // ONLY IF IT IS ACTUALLY THIS MOMENT. The preview reads whatever frame the
      // coach scrubbed to, so the track is sparse and full of holes — and
      // "nearest" over a sparse track happily returns a pose from somewhere else
      // in the lift entirely. Drawn anyway, that is a skeleton in a completely
      // different position pinned over the lifter, which reads as the model
      // being broken rather than as there being no reading here. Nothing is the
      // honest answer for a moment nothing has been measured at.
      const pose = nearest && Math.abs(nearest.t - playhead) <= POSE_MAX_STALE_S ? nearest : null
      if (pose) {
        const lm = pose.landmarks
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'

        for (const [from, to] of POSE_BONES) {
          const a = lm[from]
          const b = lm[to]
          if (!a || !b) continue
          // Greyed, never hidden, when the model could not see an end of the
          // bone. A limb that silently vanishes looks like a rendering bug; a
          // grey one says "the plates are in the way", which is the truth. The
          // rule is the tracker's, one level down: rule readings OUT, never in.
          const unsure = !isVisible(a) || !isVisible(b)
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
          ctx.lineWidth = 5
          ctx.beginPath()
          ctx.moveTo(a.x * scale, a.y * scale)
          ctx.lineTo(b.x * scale, b.y * scale)
          ctx.stroke()
          ctx.strokeStyle = unsure ? 'rgba(161, 161, 170, 0.65)' : 'rgba(34, 211, 238, 0.95)'
          ctx.lineWidth = 2.5
          ctx.stroke()
        }

        // Joints only where a bone actually reaches them, so the parked
        // landmarks of a partly-seen body do not scatter dots across the frame.
        const jointed = new Set(POSE_BONES.flat())
        for (const i of jointed) {
          const l = lm[i]
          if (!l) continue
          ctx.fillStyle = isVisible(l) ? 'rgba(224, 242, 254, 0.95)' : 'rgba(161, 161, 170, 0.6)'
          ctx.beginPath()
          ctx.arc(l.x * scale, l.y * scale, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    // Finished path if there is one, otherwise whatever tracking has produced
    // so far — so the line grows as the clip plays.
    const path = samples ?? livePathRef?.current ?? null

    // The whole path, so a track that wandered off the bar is obvious at a
    // glance. Quality numbers cannot be trusted to reveal that on their own.
    if (path && path.length > 1) {
      const trace = () => {
        ctx.beginPath()
        path.forEach((s, i) =>
          i ? ctx.lineTo(s.x * scale, s.y * scale) : ctx.moveTo(s.x * scale, s.y * scale),
        )
        ctx.stroke()
      }
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      // Dark casing under the line: whichever colour the coach picks, gym
      // footage will contain something it blends into somewhere along the path.
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.lineWidth = 5
      trace()
      ctx.strokeStyle = color
      ctx.lineWidth = 2.5
      trace()
    }

    // The dot, riding the bar: whichever sample is nearest the frame ON SCREEN.
    // `playhead` above is requestVideoFrameCallback's presented mediaTime rather
    // than video.currentTime, because the playback clock runs ahead of what the
    // compositor has drawn — the dot led the bar by a frame or two and looked
    // like it was lagging the lift on the way up.
    const marker = samples?.length
      ? samples.reduce((best, s) =>
          Math.abs(s.t - playhead) < Math.abs(best.t - playhead) ? s : best,
        )
      : (path?.[path.length - 1] ?? null)
    const point = marker ?? seed

    if (point) {
      const cx = point.x * scale
      const cy = point.y * scale
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(cx, cy, 9, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, 9, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(cx, cy, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // The search box, shown only before tracking: it is what the coach is
    // really choosing when they click, so its size should not be a mystery.
    // The scale reference, drawn distinctly from the tracking overlay so the
    // two are never confused — this one is a measurement, not a result.
    if (calibration) {
      const ax = calibration.a.x * scale
      const ay = calibration.a.y * scale
      const bx = calibration.b.x * scale
      const by = calibration.b.y * scale
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
      ctx.strokeStyle = '#fbbf24'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#fbbf24'
      for (const [px, py] of [[ax, ay], [bx, by]]) {
        ctx.beginPath()
        ctx.arc(px, py, 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // No search-box outline. The circle already shows where the tracker is
    // looking and the +/- buttons change its size, so the extra rectangle only
    // added clutter over the lift.
    ctx.restore()
    // poseRef is a ref like livePathRef, so it is not a dependency — its
    // contents change every inference without the identity ever changing, and
    // the loop below redraws every animation frame regardless.
  }, [samples, seed, videoRef, color, calibration, livePathRef, strokes, bar, poseRef, showPose])

  // Redraw every animation frame while playing so the dot tracks the bar, and
  // once on any state change so it is right while paused too.
  useEffect(() => {
    const loop = () => {
      draw()
      frameRef.current = requestAnimationFrame(loop)
    }
    frameRef.current = requestAnimationFrame(loop)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [draw])

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return

    if (disabled) {
      // The layer only sits in front of a disabled stage when the coach can
      // correct a joint, and doing so swallows the click that used to reach the
      // video and play it — which made a reopened analysis feel broken once
      // before. Hand it back, except right after a drag, where a play/pause
      // would be the opposite of what the coach just did.
      if (correcting && !justDraggedRef.current && e.detail === 1) {
        if (video.paused) void video.play().catch(() => {})
        else video.pause()
      }
      justDraggedRef.current = false
      return
    }
    // The second click of a double-click is the fullscreen gesture, not a seed.
    // Without this, going fullscreen also drops a tracking point or a
    // calibration endpoint wherever the coach happened to double-click.
    if (e.detail > 1) return
    const rect = video.getBoundingClientRect()
    const picture = pictureRect(rect.width, rect.height, video.videoWidth, video.videoHeight)
    // Inverse of draw(): out of the letterboxed picture, back to video pixels.
    const point = {
      x: (e.clientX - rect.left - picture.left) / picture.scale,
      y: (e.clientY - rect.top - picture.top) / picture.scale,
    }
    // A click in the letterbox bars is not on the lift.
    if (point.x < 0 || point.y < 0 || point.x > video.videoWidth || point.y > video.videoHeight) {
      return
    }
    // The click that ends a correction is not a request to seed the tracker or
    // to move the scale line. Only a real drag sets this — a press on a joint
    // that never moved falls through, so a plate sitting near a wrist is still
    // clickable.
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    if (mode === 'draw') return // strokes are built from pointer events, not clicks
    if (mode === 'calibrate') onCalibratePoint(point)
    else onPlaceSeed(point)
  }

  /** Video pixels for a pointer, or null when it is out over the letterbox. */
  const pointFor = (e: React.PointerEvent<HTMLDivElement>): Point | null => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return null
    const rect = video.getBoundingClientRect()
    const picture = pictureRect(rect.width, rect.height, video.videoWidth, video.videoHeight)
    const point = {
      x: (e.clientX - rect.left - picture.left) / picture.scale,
      y: (e.clientY - rect.top - picture.top) / picture.scale,
    }
    const outside =
      point.x < 0 || point.y < 0 || point.x > video.videoWidth || point.y > video.videoHeight
    return outside ? null : point
  }

  /**
   * The landmark under a pointer, if one is close enough to have been aimed at.
   *
   * The threshold is in DISPLAY pixels rather than video pixels: what matters is
   * how near the coach's finger landed on screen, and a video-pixel radius would
   * shrink to nothing on a 4K clip in a small window.
   */
  const GRAB_PX = 14

  const landmarkAt = (point: Point): { frameIndex: number; landmark: number } | null => {
    const video = videoRef.current
    const frames = poseRef?.current
    if (!video || !frames?.length || !showPose) return null

    const rect = video.getBoundingClientRect()
    const { scale } = pictureRect(rect.width, rect.height, video.videoWidth, video.videoHeight)
    const playhead = presentedRef.current ?? video.currentTime
    const frameIndex = frameIndexAt(frames, playhead)
    const frame = frames[frameIndex]
    // Same rule as the draw: a joint the coach cannot see is not one they can be
    // aiming at, and correcting a frame from elsewhere in the lift would record
    // a fix against a moment they never looked at.
    if (!frame || Math.abs(frame.t - playhead) > POSE_MAX_STALE_S) return null
    const lm = frame.landmarks

    const reach = GRAB_PX / scale
    let best: number | null = null
    let bestDist = reach
    // Only joints a bone actually reaches — the parked landmarks of a partly
    // seen body are not on screen and must not be grabbable.
    for (const i of new Set(POSE_BONES.flat())) {
      const l = lm[i]
      if (!l) continue
      const d = Math.hypot(l.x - point.x, l.y - point.y)
      if (d <= bestDist) {
        best = i
        bestDist = d
      }
    }
    return best === null ? null : { frameIndex, landmark: best }
  }

  const startStroke = (e: React.PointerEvent<HTMLDivElement>) => {
    // Correcting a joint takes precedence over drawing on it: the coach who
    // grabs a knee that is in the wrong place means to move it, and a freehand
    // circle can start a few pixels further out.
    if (correcting) {
      const at = pointFor(e)
      const hit = at && landmarkAt(at)
      if (hit) {
        // Capture so a drag that runs off the frame still ends cleanly. It can
        // throw NotFoundError if the pointer is already gone, and an exception
        // out of a pointerdown handler would take drawing down with it.
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* the drag still works, it just cannot follow the pointer off-frame */
        }
        draggingRef.current = { ...hit, from: at, moved: false }
        // Deliberately no early return: a press that turns out to be a click
        // still has to be able to seed or draw, and that is decided on release.
      }
    }
    // Deliberately not gated on `disabled`. That flag means "nothing to place",
    // and a saved analysis is always disabled — which is exactly where a coach
    // talks over a lift they tracked last week.
    if (mode !== 'draw') return
    const point = pointFor(e)
    if (!point) return
    // Capture, so a stroke that runs off the frame still ends cleanly — without
    // it the pointerup lands on some other element and the stroke never closes.
    e.currentTarget.setPointerCapture(e.pointerId)
    drawingRef.current = [point]
  }

  const extendStroke = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = draggingRef.current
    if (drag) {
      const point = pointFor(e)
      if (!point) return
      if (!drag.moved) {
        // In video pixels, scaled so the threshold is a few pixels on screen
        // rather than a few in a 4K frame.
        const video = videoRef.current
        const rect = video?.getBoundingClientRect()
        const scale =
          video && rect
            ? pictureRect(rect.width, rect.height, video.videoWidth, video.videoHeight).scale
            : 1
        if (Math.hypot(point.x - drag.from.x, point.y - drag.from.y) * scale < DRAG_SLOP_PX) return
        drag.moved = true
      }
      // Moved in the ref the overlay already reads, so the joint follows the
      // pointer at animation-frame rate without a round trip or a re-render.
      // The server hears about it once, on release.
      const frame = poseRef?.current[drag.frameIndex]
      if (frame) {
        const landmarks = frame.landmarks.slice()
        landmarks[drag.landmark] = { x: point.x, y: point.y, visibility: 1 }
        const next = poseRef!.current.slice()
        next[drag.frameIndex] = { ...frame, landmarks }
        poseRef!.current = next
      }
      return
    }
    if (!drawingRef.current) return
    const point = pointFor(e)
    // Points outside the frame are dropped rather than ending the stroke: a
    // coach circling a knee often overshoots the edge and comes back.
    if (point) drawingRef.current.push(point)
  }

  const endStroke = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = draggingRef.current
    draggingRef.current = null
    if (drag?.moved) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      // Tells the click that follows to stand down — it would otherwise seed the
      // tracker, or play the video, at the end of a correction.
      justDraggedRef.current = true
      const landed = poseRef?.current[drag.frameIndex]?.landmarks[drag.landmark]
      // Persisted once, at the end. Every intermediate position of a drag is a
      // number the coach never meant to record — the same rule the 1RM velocity
      // field follows by saving on blur rather than per keystroke.
      if (landed) onCorrectLandmark?.(drag.frameIndex, drag.landmark, landed.x, landed.y)
      return
    }
    if (drag && e.currentTarget.hasPointerCapture(e.pointerId)) {
      // A press on a joint that never moved. Release the capture and let the
      // click through to whatever it was really aimed at.
      e.currentTarget.releasePointerCapture(e.pointerId)
    }

    const points = drawingRef.current
    drawingRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (!points) return
    // A tolerance of one video pixel: invisible to the coach, and it typically
    // drops most of the points in a stroke.
    const stroke = { color, points: simplify(points, 1) }
    if (isDrawable(stroke)) onDrawStroke?.(stroke)
  }

  return (
    <div className="flex items-center justify-center bg-black/90">
      {/* The element that goes fullscreen. The canvas is a descendant, so it
          travels into the top layer with the video and the bar path and the
          coach's marks stay ON the lift at any size. Sending the <video> itself
          would leave the overlay behind, which is the whole bug — the path
          disappeared exactly when the coach wanted a closer look.
          Filling the screen in fullscreen rather than shrink-wrapping means a
          double-click on the letterbox bars counts too. */}
      <div
        ref={wrapRef}
        // Capture phase, and preventDefault, because Chromium's own media
        // controls also toggle fullscreen on a double-click — on the <video>,
        // which would strand the overlay. Left to bubble, theirs runs first and
        // ours then undoes it, so the gesture appeared to do nothing on the way
        // back out. Intercepting on the way down means one toggle, ours, in and
        // out alike.
        onDoubleClickCapture={(e) => {
          e.preventDefault()
          e.stopPropagation()
          // Double-clicking play/pause or the scrubber is aimed at the controls.
          if (inControlBar(e)) return
          toggleFullscreen()
        }}
        className={
          fullscreen
            ? 'relative flex h-full w-full items-center justify-center bg-black'
            : 'relative'
        }
      >
        {/* Shrink-wraps the video, so the overlay's origin is the video's own
            top-left and the control-bar carve-out sits over the real controls —
            not along the bottom of a screen the clip does not fill. */}
        <div ref={boxRef} className="relative">
          <video
            ref={videoRef}
            src={src}
            controls
            preload="metadata"
            playsInline
            // 62vh keeps the panel below the fold in the page; in fullscreen it
            // would cap the picture at 62% of the screen for no reason, and a
            // clip larger than the screen has to be reined in both ways.
            // stage-video hides the native fullscreen button — see index.css.
            className={`stage-video block w-auto ${
              fullscreen ? 'max-h-screen max-w-full' : 'max-h-[62vh]'
            }`}
            onLoadedMetadata={(e) => onLoadedMetadata(e.currentTarget)}
            onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
          />
          {/* Click target stops short of the browser's controls, so play and
              scrub keep working while the frame itself is clickable.
              When there is nothing to place — a saved analysis, or the live page
              mid-track — the layer stops intercepting entirely, so a click
              reaches the video and plays it. It used to swallow the click and do
              nothing, which made a reopened analysis feel broken. */}
          <div
            ref={layerRef}
            onClick={handleClick}
            onPointerDown={startStroke}
            onPointerMove={extendStroke}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            className={`absolute left-0 top-0 ${
              // Drawing needs the layer even on a saved analysis, which is always
              // disabled — that is where a coach explains a lift they tracked
              // earlier. Correcting a joint needs it for the same reason, and on
              // the same page. Only a disabled stage doing neither steps out of
              // the way; when it does not, handleClick gives click-to-play back
              // by hand, because the layer is now swallowing it.
              disabled && mode !== 'draw' && !correcting
                ? 'pointer-events-none'
                : mode === 'draw'
                  ? 'cursor-crosshair touch-none'
                  : 'cursor-crosshair'
            }`}
          >
            <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0" />
          </div>

          {/* On the video rather than in the page toolbar, because it acts on
              the video. NOT in the control bar with the browser's own buttons:
              the one that belongs in that slot is the browser's, and it cannot
              be used — it fullscreens the <video> and the bar path does not go
              with it (see index.css). This one fullscreens the wrapper, so the
              path and the coach's marks come too.
              Top-right rather than bottom-right: the bar's height is not
              knowable from script, and a guess at it lands the button on the
              scrubber. */}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen (or double-click)' : 'Fullscreen (or double-click)'}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            className="absolute right-2 top-2 rounded bg-black/50 p-1.5 text-white/80 transition hover:bg-black/70 hover:text-white"
          >
            {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
