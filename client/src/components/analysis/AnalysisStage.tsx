import { useCallback, useEffect, useRef } from 'react'
import type { Sample } from './tracker.core'
import { withAlpha } from './trackerColor'

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

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || !video.videoWidth) return

    const rect = video.getBoundingClientRect()
    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width)
      canvas.height = Math.round(rect.height)
    }
    const scale = rect.width / video.videoWidth
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // The whole path, so a track that wandered off the bar is obvious at a
    // glance. Quality numbers cannot be trusted to reveal that on their own.
    if (samples && samples.length > 1) {
      const trace = () => {
        ctx.beginPath()
        samples.forEach((s, i) =>
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

    // The dot, riding the bar: whichever sample is nearest the playhead.
    const marker = samples?.length
      ? samples.reduce((best, s) =>
          Math.abs(s.t - video.currentTime) < Math.abs(best.t - video.currentTime) ? s : best,
        )
      : null
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

    if (seed && !samples) {
      ctx.strokeStyle = withAlpha(color, 0.5)
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1
      ctx.strokeRect(
        (seed.x - seed.radius) * scale,
        (seed.y - seed.radius) * scale,
        seed.radius * 2 * scale,
        seed.radius * 2 * scale,
      )
      ctx.setLineDash([])
    }
  }, [samples, seed, videoRef, color, calibration])

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
    const rect = video.getBoundingClientRect()
    const scale = video.videoWidth / rect.width
    const point = { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale }
    if (mode === 'calibrate') onCalibratePoint(point)
    else onPlaceSeed(point)
  }

  return (
    <div className="flex justify-center bg-black/90">
      {/* Shrink-wraps the video so the overlay's origin is the video's own
          top-left, not the container's — otherwise a portrait clip in a wide
          panel puts every drawn point off to one side. */}
      <div className="relative">
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          playsInline
          className="block max-h-[62vh] w-auto"
          onLoadedMetadata={(e) => onLoadedMetadata(e.currentTarget)}
          onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        />
        {/* Click target stops short of the native controls, so play and scrub
            keep working while the frame itself is clickable. */}
        <div
          onClick={handleClick}
          className={`absolute inset-x-0 top-0 bottom-12 ${disabled ? '' : 'cursor-crosshair'}`}
        >
          <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0" />
        </div>
      </div>
    </div>
  )
}
