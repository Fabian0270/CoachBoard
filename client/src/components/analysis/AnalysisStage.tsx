import { useCallback, useEffect, useRef, useState } from 'react'
import { pictureRect } from 'coachboard-shared/videoAnalysis'
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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  /**
   * The video's own box — the picture plus the browser's control bar, and
   * nothing else.
   *
   * Everything drawn or clicked is positioned against THIS rather than the
   * wrapper. On the page the two are the same box; in fullscreen the wrapper is
   * the whole screen and the video is centred inside it, so anchoring to the
   * wrapper put the overlay over the letterbox bars and, worse, laid the click
   * layer over the control bar of a clip that did not fill the screen.
   */
  const boxRef = useRef<HTMLDivElement | null>(null)
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
   * Leaves fullscreen completely, however many levels deep it is.
   *
   * Redirecting the video's own button leaves TWO elements on the fullscreen
   * stack — the video, then the wrapper on top of it — and one exitFullscreen()
   * pops only the top one. Measured, not assumed: a single exit lands back on
   * the video being fullscreen, which is the stranded-overlay state this whole
   * effect exists to avoid. Escape is fine on its own; the spec makes it a full
   * exit, and Chromium does that.
   */
  const exitingRef = useRef(false)
  const exitFullscreenFully = useCallback(async () => {
    exitingRef.current = true
    try {
      // Bounded: a browser that refuses to exit must not spin here.
      for (let i = 0; i < 4 && document.fullscreenElement; i++) {
        await document.exitFullscreen()
      }
    } catch {
      // Nothing better to do — the coach still has Escape.
    } finally {
      exitingRef.current = false
    }
  }, [])

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
    if (document.fullscreenElement) void exitFullscreenFully()
    else void wrap.requestFullscreen().catch(() => {})
  }, [exitFullscreenFully])

  /**
   * Whatever fullscreens the VIDEO is redirected up to the wrapper.
   *
   * The video's own button — and the Fullscreen item Chromium tucks into the ⋮
   * menu when a narrow clip overflows its controls — both call
   * requestFullscreen on the <video>, which promotes only the video and leaves
   * the overlay canvas behind. Hiding the button never fixed that, because no
   * CSS reaches the overflow menu.
   *
   * So the request is not blocked, it is followed: asking for the wrapper while
   * the video is already fullscreen PUSHES it on top, and the canvas comes with
   * it. Note this is not the exitFullscreen()-then-request pattern that was
   * tried before and refused — Chromium blocks that one as a fullscreen loop.
   * Nothing is exited here, and it resolves.
   *
   * Direction matters. Coming UP from nothing is the coach entering fullscreen,
   * so redirect. Coming DOWN from the wrapper is the browser popping our own
   * push as they leave — redirecting there would trap them in fullscreen — so
   * finish the exit instead.
   */
  const previousRef = useRef<Element | null>(null)
  useEffect(() => {
    const sync = () => {
      const el = document.fullscreenElement
      const wrap = wrapRef.current
      if (el && el === videoRef.current && !exitingRef.current) {
        if (previousRef.current === wrap) void exitFullscreenFully()
        else void wrap?.requestFullscreen().catch(() => {})
      }
      previousRef.current = el
      // Escape and the browser's own exit both bypass our handler, so the flag
      // follows the document rather than our own call.
      setFullscreen(el === wrap)
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [videoRef, exitFullscreenFully])

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
    // Sized and anchored to the video's own box, which is what the canvas is
    // positioned inside. Anchoring to one element while measuring another is
    // what once drew the path hundreds of pixels to the left of the lift in
    // fullscreen, so the two are deliberately the same element here.
    const box = boxRef.current?.getBoundingClientRect() ?? rect
    if (canvas.width !== Math.round(box.width) || canvas.height !== Math.round(box.height)) {
      canvas.width = Math.round(box.width)
      canvas.height = Math.round(box.height)
    }
    // Two offsets stack: where the video sits inside its box, and where the
    // picture sits inside the video (object-fit: contain letterboxes it when the
    // aspect ratios differ).
    const picture = pictureRect(rect.width, rect.height, video.videoWidth, video.videoHeight)
    const { scale } = picture
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Origin at the picture's top-left, so every `x * scale` below stays
    // correct without threading the offset through each one.
    ctx.save()
    ctx.translate(rect.left - box.left + picture.left, rect.top - box.top + picture.top)

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
    // Not video.currentTime — that is the playback clock, which runs ahead of
    // the frame the compositor has actually presented, so the dot led the bar by
    // a frame or two and looked like it was lagging behind the lift on the way
    // up. requestVideoFrameCallback reports the presented frame's own mediaTime,
    // which is exactly what the coach is looking at. Falls back to the clock
    // where rVFC is unavailable or while paused.
    const playhead = presentedRef.current ?? video.currentTime
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
  }, [samples, seed, videoRef, color, calibration, livePathRef, strokes])

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
    if (!video || !video.videoWidth || disabled) return
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

  const startStroke = (e: React.PointerEvent<HTMLDivElement>) => {
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
    if (!drawingRef.current) return
    const point = pointFor(e)
    // Points outside the frame are dropped rather than ending the stroke: a
    // coach circling a knee often overshoots the edge and comes back.
    if (point) drawingRef.current.push(point)
  }

  const endStroke = (e: React.PointerEvent<HTMLDivElement>) => {
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
            className={`block w-auto ${fullscreen ? 'max-h-screen max-w-full' : 'max-h-[62vh]'}`}
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
            onClick={handleClick}
            onPointerDown={startStroke}
            onPointerMove={extendStroke}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            style={{ bottom: bar }}
            className={`absolute inset-x-0 top-0 ${
              // Drawing needs the layer even on a saved analysis, which is always
              // disabled — that is where a coach explains a lift they tracked
              // earlier. Only a non-drawing disabled stage steps out of the way.
              disabled && mode !== 'draw'
                ? 'pointer-events-none'
                : mode === 'draw'
                  ? 'cursor-crosshair touch-none'
                  : 'cursor-crosshair'
            }`}
          >
            <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0" />
          </div>
        </div>
      </div>
    </div>
  )
}
