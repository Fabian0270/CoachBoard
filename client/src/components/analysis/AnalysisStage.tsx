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
import { paintDot, paintPath, paintStrokes, repWindows, sampleAt } from './pathPaint'
import { useAnalysisKeys } from './analysisKeys'
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
  /**
   * Called when the coach drags an end of the scale line (BP18). Its presence
   * is what makes the ends draggable — the saved page passes nothing.
   */
  onCalibrationChange?: (line: CalibrationLine) => void
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
  /**
   * Space, ← / →, Shift+← / →, F and 1–9 drive this video (BP15). Off on the
   * Compare page, where two stages would both answer every key.
   */
  keyboard?: boolean
  /** Where each rep starts, in seconds: 1–9 jump to them. */
  repStarts?: number[]
  /** Each rep's way up (its concentric), to draw the reps apart (BP9). */
  reps?: { startT: number; endT: number }[]
  /**
   * The stretch of the clip chosen for tracking, drawn on the strip under the
   * video (BP17) before anything is tracked. Without it the strip shows the
   * tracked path's own stretch, once there are reps.
   */
  trackRange?: { from: number; to: number } | null
}

// Kept importable from here, where the pages have always found it.
export { repWindows }

/** One step of ← / →. The clip's real frame rate is not knowable from the element; 1/30 s is a frame of a phone clip. */
const FRAME_S = 1 / 30

/** The scale loupe's size on screen, and how much closer it shows the picture than the video does. */
const LOUPE_PX = 128
const LOUPE_ZOOM = 4

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
  onCalibrationChange,
  strokes,
  onDrawStroke,
  poseRef,
  showPose,
  onCorrectLandmark,
  keyboard = false,
  repStarts,
  reps,
  trackRange,
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
  /**
   * An end of the scale line being dragged (BP18). The line lives here until
   * release, like a joint being corrected, so it follows the pointer at frame
   * rate and the page hears about it once.
   */
  const calibDragRef = useRef<{ end: 'a' | 'b'; line: CalibrationLine; from: Point; moved: boolean } | null>(null)
  /** Where the pointer is over the picture, in video pixels, for the loupe. */
  const loupeAtRef = useRef<Point | null>(null)
  const loupeRef = useRef<HTMLCanvasElement | null>(null)
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

  // ── Playback by button and by key (BP15, BP16) ──────────────────────────
  /** Pause, then move by `s` seconds: a frame, or a second. */
  const step = useCallback((s: number) => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.currentTime = Math.min(Number.isFinite(v.duration) ? v.duration : Infinity, Math.max(0, v.currentTime + s))
  }, [videoRef])
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [videoRef])
  useAnalysisKeys(keyboard, (e) => {
    if (e.ctrlKey || e.metaKey) return false
    if (e.key === ' ') { togglePlay(); return true }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : FRAME_S))
      return true
    }
    if (e.key.toLowerCase() === 'f') { toggleFullscreen(); return true }
    if (/^[1-9]$/.test(e.key)) {
      const at = repStarts?.[Number(e.key) - 1]
      const v = videoRef.current
      if (at == null || !v) return false
      v.pause()
      v.currentTime = at
      return true
    }
    return false
  })

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
    paintStrokes(ctx, penStrokes, scale)

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

    // The whole path, reps apart once it is finished (BP9) — see paintPath.
    if (path) paintPath(ctx, { path, reps: samples ? reps : null, playhead, color, scale })

    // The dot, riding the bar: whichever sample is nearest the frame ON SCREEN.
    // `playhead` above is requestVideoFrameCallback's presented mediaTime rather
    // than video.currentTime, because the playback clock runs ahead of what the
    // compositor has drawn — the dot led the bar by a frame or two and looked
    // like it was lagging the lift on the way up.
    const marker = samples?.length ? sampleAt(samples, playhead) : (path?.[path.length - 1] ?? null)
    const point = marker ?? seed
    if (point) paintDot(ctx, point, color, scale)

    // The search box, shown only before tracking: it is what the coach is
    // really choosing when they click, so its size should not be a mystery.
    // The scale reference, drawn distinctly from the tracking overlay so the
    // two are never confused — this one is a measurement, not a result.
    const line = calibDragRef.current?.line ?? calibration
    // The first point placed and the second not yet (D52): a faint line
    // straight down through it, so the bottom edge is found directly below
    // and not off to one side.
    if (line && mode === 'calibrate' && line.a.x === line.b.x && line.a.y === line.b.y) {
      ctx.save()
      ctx.setLineDash([4, 6])
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(line.a.x * scale, line.a.y * scale - 12)
      ctx.lineTo(line.a.x * scale, video.videoHeight * scale)
      ctx.stroke()
      ctx.restore()
    }
    if (line) {
      const ax = line.a.x * scale
      const ay = line.a.y * scale
      const bx = line.b.x * scale
      const by = line.b.y * scale
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

    // The loupe (BP18): the picture under the pointer, close up, while setting
    // the scale or dragging an end of it. A plate's edge is a few pixels wide
    // on a phone clip, and every number on the page is in proportion to where
    // the two clicks landed. A second canvas beside the real video, like the
    // recorder's zoom — not a canvas standing in for the video.
    const loupe = loupeRef.current
    if (loupe) {
      const at = loupeAtRef.current
      const drag = calibDragRef.current
      if (!at || disabled || !(mode === 'calibrate' || drag?.moved)) {
        loupe.style.display = 'none'
      } else {
        const L = LOUPE_PX
        const src = L / (scale * LOUPE_ZOOM)
        const sx = at.x - src / 2
        const sy = at.y - src / 2
        const px = picture.left + at.x * scale
        const py = picture.top + at.y * scale
        // Up and to the right of the pointer, so the hand never covers it;
        // flipped at the edges of the picture.
        const left = px + 24 + L > rect.width ? px - 24 - L : px + 24
        const top = py - 24 - L < 0 ? py + 24 : py - 24 - L
        loupe.style.display = 'block'
        loupe.style.left = `${offsetX + left}px`
        loupe.style.top = `${offsetY + top}px`
        if (loupe.width !== L) { loupe.width = L; loupe.height = L }
        const lc = loupe.getContext('2d')
        if (lc) {
          lc.fillStyle = '#000'
          lc.fillRect(0, 0, L, L)
          lc.drawImage(video, sx, sy, src, src, 0, 0, L, L)
          const toLoupe = (p: Point) => [(p.x - sx) * (L / src), (p.y - sy) * (L / src)] as const
          if (line) {
            const [ax, ay] = toLoupe(line.a)
            const [bx, by] = toLoupe(line.b)
            lc.setLineDash([6, 4])
            lc.strokeStyle = '#fbbf24'
            lc.lineWidth = 1.5
            lc.beginPath()
            lc.moveTo(ax, ay)
            lc.lineTo(bx, by)
            lc.stroke()
            lc.setLineDash([])
          }
          lc.strokeStyle = 'rgba(255, 255, 255, 0.85)'
          lc.lineWidth = 1
          lc.beginPath()
          lc.moveTo(L / 2, L / 2 - 12)
          lc.lineTo(L / 2, L / 2 + 12)
          lc.moveTo(L / 2 - 12, L / 2)
          lc.lineTo(L / 2 + 12, L / 2)
          lc.stroke()
        }
      }
    }
    // poseRef is a ref like livePathRef, so it is not a dependency — its
    // contents change every inference without the identity ever changing, and
    // the loop below redraws every animation frame regardless.
  }, [samples, seed, videoRef, color, calibration, livePathRef, strokes, bar, poseRef, showPose, reps, mode, disabled])

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
    // The click that ends a correction or a scale-end drag is not a request to
    // seed the tracker or to start a new scale line. Only a real drag sets this
    // — a press that never moved falls through, so a plate sitting near a wrist
    // is still clickable. Cleared before anything else can return, or a drag
    // that ended over the letterbox would swallow the next real click.
    if (justDraggedRef.current) {
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

  /** Screen pixels per video pixel, right now. */
  const displayScale = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return 1
    const rect = video.getBoundingClientRect()
    return pictureRect(rect.width, rect.height, video.videoWidth, video.videoHeight).scale
  }

  /** Whether the scale line's ends can be dragged here at all (BP18). */
  const canAdjustScale = !!onCalibrationChange && !!calibration && !disabled && mode !== 'draw'

  /**
   * The end of the scale line under a pointer, if one is close enough to have
   * been aimed at. Same on-screen reach as a joint. Nothing while the line is
   * still a single point (the first click of two).
   */
  const calibrationEndAt = (point: Point): 'a' | 'b' | null => {
    if (!calibration) return null
    const s = displayScale()
    const { a, b } = calibration
    if (Math.hypot(a.x - b.x, a.y - b.y) * s < GRAB_PX) return null
    const da = Math.hypot(a.x - point.x, a.y - point.y) * s
    const db = Math.hypot(b.x - point.x, b.y - point.y) * s
    if (!(Math.min(da, db) <= GRAB_PX)) return null
    return da <= db ? 'a' : 'b'
  }

  const startStroke = (e: React.PointerEvent<HTMLDivElement>) => {
    // An end of the scale line comes first: it is small, it was put there on
    // purpose, and a press that never moves still falls through as a click.
    if (canAdjustScale) {
      const at = pointFor(e)
      const end = at && calibrationEndAt(at)
      if (at && end) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* the drag still works, it just cannot follow the pointer off-frame */
        }
        calibDragRef.current = { end, line: calibration!, from: at, moved: false }
        return
      }
    }
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
    const here = pointFor(e)
    loupeAtRef.current = here
    const cd = calibDragRef.current
    if (cd) {
      if (!here) return
      if (!cd.moved) {
        if (Math.hypot(here.x - cd.from.x, here.y - cd.from.y) * displayScale() < DRAG_SLOP_PX) return
        cd.moved = true
        e.currentTarget.style.cursor = 'grabbing'
      }
      cd.line = { ...cd.line, [cd.end]: here }
      return
    }
    if (canAdjustScale) e.currentTarget.style.cursor = here && calibrationEndAt(here) ? 'grab' : ''
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
    const cd = calibDragRef.current
    if (cd) {
      calibDragRef.current = null
      e.currentTarget.style.cursor = ''
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      if (cd.moved) {
        // The click that follows a drag is not a new first point.
        justDraggedRef.current = true
        onCalibrationChange?.(cd.line)
      }
      return
    }
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
    <div className="flex flex-col items-center justify-center bg-black/90">
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
            onPointerLeave={() => { if (!calibDragRef.current) loupeAtRef.current = null }}
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
          <canvas
            ref={loupeRef}
            aria-hidden
            style={{ display: 'none', width: LOUPE_PX, height: LOUPE_PX }}
            className="pointer-events-none absolute rounded-full border-2 border-white/80 shadow-lg"
          />

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
      <PlaybackBar videoRef={videoRef} onStep={step} />
      {(() => {
        const tracked = reps && reps.length > 0 && samples && samples.length > 1
        const range = trackRange ?? (tracked ? { from: samples[0].t, to: samples[samples.length - 1].t } : null)
        if (!range) return null
        return <RepStrip videoRef={videoRef} windows={tracked ? repWindows(reps, samples[0].t) : []} range={range} />
      })()}
    </div>
  )
}

/**
 * The clip as a strip (BP17): the tracked range, each rep as a block. Click
 * anywhere to go there, a block to go to that rep, and Loop to play the rep
 * under the playhead over and over. The range used to be two buttons with
 * timestamps and nothing to see.
 */
function RepStrip({ videoRef, windows, range }: {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  windows: { from: number; bottom: number; to: number }[]
  range: { from: number; to: number }
}) {
  const [now, setNow] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loop, setLoop] = useState<number | null>(null)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const sync = () => {
      setNow(v.currentTime)
      if (Number.isFinite(v.duration)) setDuration(v.duration)
    }
    sync()
    v.addEventListener('timeupdate', sync)
    v.addEventListener('durationchange', sync)
    v.addEventListener('seeked', sync)
    return () => {
      v.removeEventListener('timeupdate', sync)
      v.removeEventListener('durationchange', sync)
      v.removeEventListener('seeked', sync)
    }
  }, [videoRef])
  // Loop: past the end of the rep, back to its top.
  useEffect(() => {
    const v = videoRef.current
    if (!v || loop == null) return
    const w = windows[loop]
    if (!w) return
    const keep = () => { if (v.currentTime > w.to || v.currentTime < w.from - 0.05) v.currentTime = w.from }
    v.addEventListener('timeupdate', keep)
    return () => v.removeEventListener('timeupdate', keep)
  }, [videoRef, loop, windows])

  const total = duration > 0 ? duration : range.to
  // A clip whose length is not known yet (a WebM straight from a recorder
  // reports Infinity until it has been played to the end) has nowhere to put
  // anything.
  if (!(Number.isFinite(total) && total > 0)) return null
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / total) * 100))}%`
  const seek = (t: number) => { const v = videoRef.current; if (v) v.currentTime = t }
  const under = windows.findIndex((w) => now >= w.from && now <= w.to)
  return (
    <div className="flex w-full items-center gap-2 border-t border-white/10 px-2 py-1.5">
      <div
        role="group"
        aria-label="Reps in the clip"
        className="relative h-6 flex-1 cursor-pointer rounded bg-white/5"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          seek(((e.clientX - r.left) / r.width) * total)
        }}
      >
        <span aria-hidden className="absolute inset-y-0 rounded bg-white/10" style={{ left: pct(range.from), width: `calc(${pct(range.to)} - ${pct(range.from)})` }} />
        {windows.map((w, i) => (
          <button
            key={i}
            type="button"
            onClick={(e) => { e.stopPropagation(); seek(w.from) }}
            aria-label={`Rep ${i + 1}`}
            title={`Rep ${i + 1}: go to its start`}
            className={`absolute inset-y-0.5 rounded-sm text-[10px] font-medium leading-5 text-white/90 transition-colors ${
              i === under ? 'bg-primary/80' : 'bg-white/25 hover:bg-white/40'
            }`}
            style={{ left: pct(w.from), width: `calc(${pct(w.to)} - ${pct(w.from)})` }}
          >
            {i + 1}
          </button>
        ))}
        <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(now) }} />
      </div>
      {windows.length > 0 && <button
        type="button"
        aria-pressed={loop !== null}
        disabled={loop === null && under === -1}
        onClick={() => setLoop((l) => (l !== null ? null : under >= 0 ? under : null))}
        title={loop !== null ? `Looping rep ${loop + 1} — click to stop` : 'Loop the rep under the playhead'}
        className={`rounded px-2 py-1 text-xs transition disabled:opacity-40 ${loop !== null ? 'bg-primary text-primary-foreground' : 'text-white/80 hover:bg-white/10 hover:text-white'}`}
      >
        {loop !== null ? `Looping rep ${loop + 1}` : 'Loop rep'}
      </button>}
    </div>
  )
}

const SPEEDS = [0.25, 0.5, 1]

/**
 * Frame steps and slow motion as buttons (BP16). Slow motion was only in
 * Chromium's own ⋮ menu on the video, and stepping a frame was not there at
 * all; both are how a coach reads a sticking point.
 */
function PlaybackBar({ videoRef, onStep }: {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  onStep: (seconds: number) => void
}) {
  const [rate, setRate] = useState(1)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const sync = () => setRate(v.playbackRate)
    sync()
    v.addEventListener('ratechange', sync)
    return () => v.removeEventListener('ratechange', sync)
  }, [videoRef])
  const btn = 'rounded px-2 py-1 text-xs text-white/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60'
  return (
    <div role="group" aria-label="Playback" className="flex w-full flex-wrap items-center justify-center gap-1 border-t border-white/10 px-2 py-1">
      <button type="button" className={btn} onClick={() => onStep(-1)} title="Back one second (Shift+←)" aria-label="Back one second">« 1 s</button>
      <button type="button" className={btn} onClick={() => onStep(-FRAME_S)} title="Back one frame (←)" aria-label="Back one frame">‹ frame</button>
      <button type="button" className={btn} onClick={() => onStep(FRAME_S)} title="Forward one frame (→)" aria-label="Forward one frame">frame ›</button>
      <button type="button" className={btn} onClick={() => onStep(1)} title="Forward one second (Shift+→)" aria-label="Forward one second">1 s »</button>
      <span aria-hidden className="mx-2 h-4 w-px bg-white/20" />
      {SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={rate === s}
          onClick={() => { if (videoRef.current) videoRef.current.playbackRate = s }}
          title={s === 1 ? 'Normal speed' : `Slow motion, ${s}×`}
          className={`${btn} ${rate === s ? 'bg-white/15 text-white' : ''}`}
        >
          {s}×
        </button>
      ))}
    </div>
  )
}
