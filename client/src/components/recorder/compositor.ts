import type { EncodingPlan } from './recorder.core'

// ---------------------------------------------------------------------------
// Draws the captured screen and the webcam into one canvas, which is what
// MediaRecorder actually records.
//
// The obvious cheaper design — record the display stream directly and let the
// webcam be an on-screen DOM element that the capture happens to pick up — only
// works while the coach is recording CoachBoard's own window. They can pick any
// window or screen, so a bubble living in our page would simply be absent from
// a recording of Excel. Compositing puts it over every source identically.
//
// Drawing a <video> to a canvas at 30fps is already proven in this codebase:
// the whole 11b tracker depends on it (see captureFrames.ts). The warning in
// AnalysisStage about drawImage and blank frames is about using a canvas as the
// primary *display* surface, which this is not.
// ---------------------------------------------------------------------------

/** Where the webcam bubble sits, as a fraction of the canvas. */
export type BubbleCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

/** Bubble diameter as a fraction of the canvas's short edge. */
const BUBBLE_FRACTION = 0.22
const BUBBLE_MARGIN_FRACTION = 0.03

export interface CompositorOptions {
  display: MediaStream
  webcam: MediaStream | null
  plan: EncodingPlan
  corner: BubbleCorner
}

export interface CompositorStats {
  /** Frames the compositor has drawn. */
  framesDrawn: number
  /** Measured over the last second, so a stall shows up immediately. */
  fps: number
  /** rAF callbacks deliberately skipped to hold the target rate. */
  framesSkipped: number
}

export interface Compositor {
  /** The stream to hand to MediaRecorder. */
  readonly stream: MediaStream
  readonly canvas: HTMLCanvasElement
  setCorner(corner: BubbleCorner): void
  stats(): CompositorStats
  stop(): void
}

/**
 * A hidden video that still decodes.
 *
 * `display:none` is deliberately NOT used: Chromium throttles frame production
 * for a fully hidden video, and 11a lost real debugging time to exactly that.
 * A 1px, fully transparent element is visible as far as the compositor is
 * concerned and invisible as far as the coach is concerned.
 */
function createHiddenVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement('video')
  video.srcObject = stream
  // Muted matters for more than politeness: an unmuted video of the loopback
  // capture would feed the machine's own output straight back into it.
  video.muted = true
  video.playsInline = true
  video.autoplay = true
  video.style.cssText =
    'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(video)
  return video
}

/** Largest centred rect of `srcW`x`srcH` that fits in the canvas, letterboxed. */
function fitContain(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { x: number; y: number; w: number; h: number } {
  if (!(srcW > 0) || !(srcH > 0)) return { x: 0, y: 0, w: dstW, h: dstH }
  const scale = Math.min(dstW / srcW, dstH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h }
}

/** Centred square crop, so a 16:9 webcam fills the circle instead of squashing. */
function fitCover(srcW: number, srcH: number): { sx: number; sy: number; size: number } {
  const size = Math.min(srcW, srcH)
  return { sx: (srcW - size) / 2, sy: (srcH - size) / 2, size }
}

export function createCompositor({
  display,
  webcam,
  plan,
  corner,
}: CompositorOptions): Compositor {
  const canvas = document.createElement('canvas')
  canvas.width = plan.width
  canvas.height = plan.height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not get a 2d context for the recorder')

  const displayVideo = createHiddenVideo(display)
  const webcamVideo = webcam ? createHiddenVideo(webcam) : null

  let activeCorner = corner
  let framesDrawn = 0
  let framesSkipped = 0
  let fps = 0
  let windowStart = performance.now()
  let windowFrames = 0
  let raf: number | null = null
  let stopped = false
  let lastDrawAt = 0

  /**
   * requestAnimationFrame fires at the display's refresh rate, which the spike
   * measured at 165 Hz on a real machine — five and a half times the rate being
   * recorded. Every one of those extra draws downscaled a 2560x1600 screen for
   * frames captureStream would never sample, which on a laptop is heat and
   * battery spent on nothing during a ten-minute recording.
   *
   * rAF is still the right clock (it yields when the window is occluded, which
   * a setInterval would not); it is just gated. The 0.9 tolerance matters: a
   * refresh tick rarely lands exactly on the interval, and demanding the full
   * 33.3 ms would drop every other frame at 60 Hz and land at ~27 fps at 165.
   */
  const frameIntervalMs = (1000 / plan.frameRate) * 0.9

  const drawBubble = (video: HTMLVideoElement) => {
    if (!video.videoWidth) return
    const short = Math.min(canvas.width, canvas.height)
    const diameter = Math.round(short * BUBBLE_FRACTION)
    const margin = Math.round(short * BUBBLE_MARGIN_FRACTION)
    const radius = diameter / 2

    const cx =
      activeCorner === 'bottom-right' || activeCorner === 'top-right'
        ? canvas.width - margin - radius
        : margin + radius
    const cy =
      activeCorner === 'bottom-right' || activeCorner === 'bottom-left'
        ? canvas.height - margin - radius
        : margin + radius

    const { sx, sy, size } = fitCover(video.videoWidth, video.videoHeight)

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(video, sx, sy, size, size, cx - radius, cy - radius, diameter, diameter)
    ctx.restore()

    // A rim, because a circular crop of a dim room against a dark screenshot
    // otherwise has no edge at all and reads as a smudge.
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = Math.max(2, Math.round(short * 0.004))
    ctx.stroke()
  }

  const draw = (now: number) => {
    if (stopped) return
    raf = requestAnimationFrame(draw)

    if (now - lastDrawAt < frameIntervalMs) {
      framesSkipped++
      return
    }
    lastDrawAt = now

    // Black rather than clearRect: the canvas is opaque (alpha:false) and any
    // letterbox bar has to be a colour, not transparency, or it records as
    // whatever was in the buffer before.
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    if (displayVideo.videoWidth) {
      const { x, y, w, h } = fitContain(
        displayVideo.videoWidth,
        displayVideo.videoHeight,
        canvas.width,
        canvas.height,
      )
      ctx.drawImage(displayVideo, x, y, w, h)
    }

    if (webcamVideo) drawBubble(webcamVideo)

    framesDrawn++
    windowFrames++
    if (now - windowStart >= 1000) {
      fps = Math.round((windowFrames * 1000) / (now - windowStart))
      windowStart = now
      windowFrames = 0
    }
  }

  // play() can reject if the element is torn down before the stream starts;
  // that is not an error worth surfacing to the coach.
  void displayVideo.play().catch(() => {})
  void webcamVideo?.play().catch(() => {})
  raf = requestAnimationFrame(draw)

  const stream = canvas.captureStream(plan.frameRate)

  return {
    stream,
    canvas,
    setCorner: (next) => {
      activeCorner = next
    },
    stats: () => ({ framesDrawn, fps, framesSkipped }),
    stop: () => {
      stopped = true
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
      for (const track of stream.getTracks()) track.stop()
      for (const video of [displayVideo, webcamVideo]) {
        if (!video) continue
        video.pause()
        video.srcObject = null
        video.remove()
      }
    },
  }
}
