import { useCallback, useEffect, useRef, useState } from 'react'
import { pictureRect } from 'coachboard-shared/videoAnalysis'
import type { Sample } from './tracker.core'

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
export type StageMode = 'seed' | 'calibrate'

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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  /** mediaTime of the frame the compositor last put on screen. */
  const presentedRef = useRef<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

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
  // follows the document rather than our own call.
  useEffect(() => {
    const sync = () => {
      // If anything managed to fullscreen the VIDEO rather than the wrapper,
      // the overlay is left behind — so hand it back to the wrapper. The native
      // fullscreen button is hidden (see index.css) precisely because it does
      // this, but the redirect stays as a net for any route that reaches it.
      if (document.fullscreenElement && document.fullscreenElement === videoRef.current) {
        void document
          .exitFullscreen()
          .then(() => wrapRef.current?.requestFullscreen())
          .catch(() => {})
        return
      }
      setFullscreen(document.fullscreenElement === wrapRef.current)
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [videoRef])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || !video.videoWidth) return

    const rect = video.getBoundingClientRect()
    // The canvas covers the WRAPPER, not the video. On the page the two are the
    // same box because the wrapper shrink-wraps the clip; in fullscreen the
    // wrapper is the whole screen and the video is centred inside it, so sizing
    // the canvas to the video while anchoring it to the wrapper drew the path
    // hundreds of pixels to the left of the lift.
    const wrap = wrapRef.current?.getBoundingClientRect() ?? rect
    if (canvas.width !== Math.round(wrap.width) || canvas.height !== Math.round(wrap.height)) {
      canvas.width = Math.round(wrap.width)
      canvas.height = Math.round(wrap.height)
    }
    // Two offsets stack: where the video sits inside the wrapper, and where the
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
    ctx.translate(rect.left - wrap.left + picture.left, rect.top - wrap.top + picture.top)

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
  }, [samples, seed, videoRef, color, calibration, livePathRef])

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
    if (mode === 'calibrate') onCalibratePoint(point)
    else onPlaceSeed(point)
  }

  return (
    <div className="flex items-center justify-center bg-black/90">
      {/* Shrink-wraps the video so the overlay's origin is the video's own
          top-left, not the container's — otherwise a portrait clip in a wide
          panel puts every drawn point off to one side.
          This is also the element that goes fullscreen: the canvas is a
          descendant, so it travels into the top layer with the video. Sending
          the <video> itself would leave the overlay behind, which is the whole
          bug — the path disappeared exactly when the coach wanted a closer look. */}
      <div
        ref={wrapRef}
        onDoubleClick={toggleFullscreen}
        className={
          fullscreen
            ? 'relative flex h-full w-full items-center justify-center bg-black'
            : 'relative'
        }
      >
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          playsInline
          // 62vh keeps the panel below the fold in the page; in fullscreen it
          // would cap the picture at 62% of the screen for no reason.
          // stage-video hides the native fullscreen button — see index.css.
          className={`stage-video block w-auto ${fullscreen ? 'max-h-screen' : 'max-h-[62vh]'}`}
          onLoadedMetadata={(e) => onLoadedMetadata(e.currentTarget)}
          onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        />
        {/* Click target stops short of the native controls, so play and scrub
            keep working while the frame itself is clickable. The bar is taller
            in fullscreen, so the carve-out grows with it.
            When there is nothing to place — a saved analysis, or the live page
            mid-track — the layer stops intercepting entirely, so a click reaches
            the video and plays it. It used to swallow the click and do nothing,
            which made a reopened analysis feel broken. */}
        <div
          onClick={handleClick}
          className={`absolute inset-x-0 top-0 ${fullscreen ? 'bottom-20' : 'bottom-12'} ${
            disabled ? 'pointer-events-none' : 'cursor-crosshair'
          }`}
        >
          <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0" />
        </div>
      </div>
    </div>
  )
}
