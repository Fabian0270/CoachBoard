import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Video, VideoOff } from 'lucide-react'
import { formatDuration } from './recorder.core'
import {
  MAX_BUBBLE_SIZE,
  MIN_BUBBLE_SIZE,
  bubbleCircle,
  clampPlacement,
  clampTrim,
  type Trim,
  type WebcamPlacement,
} from './recordingEdit'

// ---------------------------------------------------------------------------
// The editing preview: the recording with the webcam circle on top, where it
// can be dragged, resized or hidden, and a timeline whose two handles cut the
// start and end off.
//
// A preview only. Nothing here changes a file — the screen and the webcam are
// two separate recordings played in step, with the circle as a DOM element over
// the video. The same placement and trim go to recordingExport.ts, which is
// what actually builds the video, drawing from the same geometry
// (recordingEdit.ts) so the result matches what is shown here.
// ---------------------------------------------------------------------------

interface Props {
  recordingId: string
  /** Null when no webcam was recorded: no circle, no webcam controls. */
  cameraOffsetMs: number | null
  placement: WebcamPlacement
  onPlacement(next: WebcamPlacement): void
  trim: Trim
  onTrim(next: Trim): void
  /** Length of the recording in seconds; 0 until it is known. */
  duration: number
  onDuration(seconds: number): void
  /** Frame size, reported once known, so the caller can default the placement. */
  onFrameSize(width: number, height: number): void
  disabled?: boolean
}

/** Keeps a drag attached to its element. Capture can be refused for some pointers; the drag then just ends at the edge. */
function capture(e: React.PointerEvent): void {
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {
    /* not capturable — carry on without */
  }
}

/** The webcam is re-synced when it drifts further than this from the screen. */
const SYNC_TOLERANCE_S = 0.12

/**
 * A MediaRecorder file carries no duration, so the element reports Infinity
 * until it has been made to look for the end. Seeking far past it does that.
 */
function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration)
  return new Promise((resolve) => {
    const done = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return
      video.removeEventListener('durationchange', done)
      video.removeEventListener('timeupdate', done)
      const found = video.duration
      video.currentTime = 0
      resolve(found)
    }
    video.addEventListener('durationchange', done)
    video.addEventListener('timeupdate', done)
    video.currentTime = Number.MAX_SAFE_INTEGER
  })
}

export default function RecordingEditor({
  recordingId,
  cameraOffsetMs,
  placement,
  onPlacement,
  trim,
  onTrim,
  duration,
  onDuration,
  onFrameSize,
  disabled = false,
}: Props) {
  const screenRef = useRef<HTMLVideoElement | null>(null)
  const cameraRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const hasCamera = cameraOffsetMs !== null
  const offset = (cameraOffsetMs ?? 0) / 1000
  const base = `/api/recorder/recordings/${encodeURIComponent(recordingId)}/file`

  // Latest values for event handlers that must not be re-bound on every change.
  const trimRef = useRef(trim)
  trimRef.current = trim

  // --- metadata -----------------------------------------------------------
  useEffect(() => {
    const video = screenRef.current
    if (!video) return
    let cancelled = false
    const onMeta = () => {
      setFrame({ width: video.videoWidth, height: video.videoHeight })
      onFrameSize(video.videoWidth, video.videoHeight)
      void resolveDuration(video).then((seconds) => {
        if (!cancelled) onDuration(seconds)
      })
    }
    if (video.readyState >= 1) onMeta()
    else video.addEventListener('loadedmetadata', onMeta, { once: true })
    return () => {
      cancelled = true
      video.removeEventListener('loadedmetadata', onMeta)
    }
    // Once per recording; the callbacks are setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId])

  // The stage's on-screen size, for placing the circle in pixels.
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setStage({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    setStage({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [frame.width, frame.height])

  // --- playback, kept inside the trim, with the webcam in step --------------
  const syncCamera = useCallback(() => {
    const screen = screenRef.current
    const camera = cameraRef.current
    if (!screen || !camera) return
    const wanted = Math.max(0, screen.currentTime - offset)
    if (Math.abs(camera.currentTime - wanted) > SYNC_TOLERANCE_S) camera.currentTime = wanted
  }, [offset])

  useEffect(() => {
    const screen = screenRef.current
    if (!screen) return
    const onTime = () => {
      const { start, end } = trimRef.current
      if (end > 0 && screen.currentTime >= end) {
        screen.pause()
        screen.currentTime = end
      } else if (screen.currentTime < start - 0.05) {
        screen.currentTime = start
      }
      setTime(screen.currentTime)
      syncCamera()
    }
    const onPlay = () => {
      setPlaying(true)
      syncCamera()
      void cameraRef.current?.play().catch(() => {})
    }
    const onPause = () => {
      setPlaying(false)
      cameraRef.current?.pause()
    }
    screen.addEventListener('timeupdate', onTime)
    screen.addEventListener('seeked', onTime)
    screen.addEventListener('play', onPlay)
    screen.addEventListener('pause', onPause)
    return () => {
      screen.removeEventListener('timeupdate', onTime)
      screen.removeEventListener('seeked', onTime)
      screen.removeEventListener('play', onPlay)
      screen.removeEventListener('pause', onPause)
    }
  }, [syncCamera])

  const seek = (seconds: number) => {
    const screen = screenRef.current
    if (!screen) return
    screen.currentTime = Math.min(trim.end, Math.max(trim.start, seconds))
  }

  const togglePlay = () => {
    const screen = screenRef.current
    if (!screen) return
    if (!screen.paused) {
      screen.pause()
      return
    }
    // At (or past) the end of the kept span: play it again from its start.
    if (screen.currentTime >= trim.end - 0.05 || screen.currentTime < trim.start) screen.currentTime = trim.start
    void screen.play().catch(() => {})
  }

  // --- dragging the circle --------------------------------------------------
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const circle = bubbleCircle(placement, stage.width, stage.height)

  const onCirclePointerDown = (e: React.PointerEvent) => {
    if (disabled || !stageRef.current) return
    const rect = stageRef.current.getBoundingClientRect()
    // Remember where inside the circle it was grabbed, so it does not jump.
    dragRef.current = { dx: e.clientX - rect.left - circle.cx, dy: e.clientY - rect.top - circle.cy }
    capture(e)
    e.preventDefault()
  }
  const onCirclePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || !stageRef.current || !stage.width || !stage.height) return
    const rect = stageRef.current.getBoundingClientRect()
    onPlacement(
      clampPlacement(
        {
          ...placement,
          x: (e.clientX - rect.left - drag.dx) / stage.width,
          y: (e.clientY - rect.top - drag.dy) / stage.height,
        },
        stage.width,
        stage.height,
      ),
    )
  }
  const onCirclePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Arrow keys nudge it, for anyone not using a mouse.
  const onCircleKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const delta = move[e.key]
    if (!delta || disabled) return
    e.preventDefault()
    onPlacement(
      clampPlacement({ ...placement, x: placement.x + delta[0], y: placement.y + delta[1] }, frame.width, frame.height),
    )
  }

  // --- trim handles ---------------------------------------------------------
  const barRef = useRef<HTMLDivElement | null>(null)
  const trimDrag = useRef<'start' | 'end' | null>(null)
  const timeAt = (clientX: number): number => {
    const bar = barRef.current
    if (!bar || !(duration > 0)) return 0
    const rect = bar.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration
  }
  const onHandleDown = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    if (disabled) return
    trimDrag.current = which
    capture(e)
    e.preventDefault()
    e.stopPropagation()
  }
  const onHandleMove = (e: React.PointerEvent) => {
    const which = trimDrag.current
    if (!which) return
    const t = timeAt(e.clientX)
    const next =
      which === 'start'
        ? clampTrim({ start: Math.min(t, trim.end), end: trim.end }, duration)
        : // Clamp from the end's side: keep the start, move the end.
          { start: trim.start, end: clampTrim({ start: trim.start, end: t }, duration).end }
    onTrim(next)
    // Show the frame being cut at, so the coach sees where the video will start or end.
    const screen = screenRef.current
    if (screen) screen.currentTime = which === 'start' ? next.start : next.end
  }
  const onHandleUp = (e: React.PointerEvent) => {
    trimDrag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const onHandleKey = (which: 'start' | 'end') => (e: React.KeyboardEvent) => {
    if (disabled || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1)
    onTrim(
      which === 'start'
        ? clampTrim({ start: Math.min(trim.start + step, trim.end), end: trim.end }, duration)
        : { start: trim.start, end: clampTrim({ start: trim.start, end: trim.end + step }, duration).end },
    )
  }

  const pct = (seconds: number): string => (duration > 0 ? `${(seconds / duration) * 100}%` : '0%')
  const kept = Math.max(0, trim.end - trim.start)

  return (
    <div className="mt-4 space-y-3">
      {/* The stage hugs the video's own shape, so fractions of it are fractions of the frame. */}
      <div className="flex justify-center rounded bg-black">
        <div
          ref={stageRef}
          className="relative"
          // Width-driven with a fixed aspect ratio, so the box is the video's
          // shape at any window size: as wide as fits, never taller than 50vh.
          style={
            frame.width
              ? {
                  aspectRatio: `${frame.width} / ${frame.height}`,
                  width: `min(100%, calc(50vh * ${frame.width / frame.height}))`,
                }
              : { width: '100%', aspectRatio: '16 / 9' }
          }
        >
          <video
            ref={screenRef}
            src={`${base}?track=screen`}
            className="block h-full w-full"
            playsInline
            onClick={togglePlay}
            aria-label="Recording preview"
          />
          {hasCamera && (
            <div
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label="Webcam position. Drag, or use the arrow keys."
              aria-valuetext={`${Math.round(placement.x * 100)}% across, ${Math.round(placement.y * 100)}% down`}
              aria-valuenow={Math.round(placement.x * 100)}
              onPointerDown={onCirclePointerDown}
              onPointerMove={onCirclePointerMove}
              onPointerUp={onCirclePointerUp}
              onPointerCancel={onCirclePointerUp}
              onKeyDown={onCircleKeyDown}
              className={`absolute overflow-hidden rounded-full outline outline-2 outline-white/85 focus-visible:ring-2 focus-visible:ring-primary ${
                disabled ? '' : 'cursor-grab active:cursor-grabbing'
              }`}
              style={{
                left: circle.cx - circle.radius,
                top: circle.cy - circle.radius,
                width: circle.radius * 2,
                height: circle.radius * 2,
                touchAction: 'none',
                // Kept in the DOM while hidden so it stays in step when shown again.
                visibility: placement.hidden || !stage.width ? 'hidden' : 'visible',
              }}
            >
              <video
                ref={cameraRef}
                src={`${base}?track=camera`}
                muted
                playsInline
                className="pointer-events-none h-full w-full object-cover"
              />
            </div>
          )}
        </div>
      </div>

      {/* Transport + timeline. The two handles are the trim; the dot is the playhead. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          disabled={disabled || !(duration > 0)}
          className="rounded-full border border-input p-2 hover:bg-accent disabled:opacity-50"
          aria-label={playing ? 'Pause preview' : 'Play preview'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <div
          ref={barRef}
          className="relative h-8 flex-1 select-none"
          onPointerDown={(e) => {
            if (!disabled && !trimDrag.current) seek(timeAt(e.clientX))
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/60"
            style={{ left: pct(trim.start), width: pct(kept) }}
          />
          <div
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
            style={{ left: pct(Math.min(Math.max(time, trim.start), trim.end || time)) }}
          />
          {(['start', 'end'] as const).map((which) => (
            <div
              key={which}
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={which === 'start' ? 'Trim start' : 'Trim end'}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration * 10) / 10}
              aria-valuenow={Math.round(trim[which] * 10) / 10}
              aria-valuetext={formatDuration(trim[which] * 1000)}
              onPointerDown={onHandleDown(which)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              onKeyDown={onHandleKey(which)}
              className="absolute top-0 h-8 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-primary focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: pct(trim[which]), touchAction: 'none' }}
            />
          ))}
        </div>
        <span className="w-28 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {formatDuration(Math.max(0, time - trim.start) * 1000)} / {formatDuration(kept * 1000)}
        </span>
      </div>

      {hasCamera && (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <button
            type="button"
            onClick={() => onPlacement({ ...placement, hidden: !placement.hidden })}
            disabled={disabled}
            aria-pressed={!placement.hidden}
            className="flex items-center gap-2 rounded-md border border-input px-3 py-1.5 hover:bg-accent disabled:opacity-50"
          >
            {placement.hidden ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
            {placement.hidden ? 'Webcam hidden' : 'Webcam shown'}
          </button>
          <label className="flex items-center gap-2 text-muted-foreground">
            Size
            <input
              type="range"
              min={MIN_BUBBLE_SIZE}
              max={MAX_BUBBLE_SIZE}
              step={0.01}
              value={placement.size}
              disabled={disabled || placement.hidden}
              onChange={(e) =>
                onPlacement(clampPlacement({ ...placement, size: Number(e.target.value) }, frame.width, frame.height))
              }
              aria-label="Webcam size"
            />
          </label>
          {!placement.hidden && <span className="text-xs text-muted-foreground">Drag the circle to move it.</span>}
        </div>
      )}
    </div>
  )
}
