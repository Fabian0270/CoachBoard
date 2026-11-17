import type { Stroke } from './annotations'
import { paintDot, paintPath, paintStrokes, sampleAt } from './pathPaint'

// ---------------------------------------------------------------------------
// An image to send the athlete (BP24): the frame on screen with the path as
// the coach sees it, and under it a band with what the set was, each rep's
// speed and the coach's note (D49). Drawn from the video element itself, so it
// is exactly the frame the coach paused on.
// ---------------------------------------------------------------------------

export interface PathImageOptions {
  video: HTMLVideoElement
  track: { t: number; x: number; y: number }[]
  reps: { startT: number; endT: number }[]
  strokes: Stroke[]
  color: string
  /** "Back squat · 150 kg · Ann · 2026-11-17" */
  title: string
  /** One entry per rep, e.g. "0.62 m/s". */
  repSpeeds: string[]
  note: string | null
}

/** Long edge cap: what the athlete needs survives 720p-class images, like the recorder's video. */
const MAX_LONG_EDGE = 1280

/** Splits text into lines that fit a width. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width > width && line) {
        lines.push(line)
        line = word
      } else line = next
    }
    lines.push(line)
  }
  return lines
}

export function buildPathImage(opts: PathImageOptions): Promise<Blob> {
  const { video, track, reps, strokes, color, title, repSpeeds, note } = opts
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return Promise.reject(new Error('The video has no picture yet.'))
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(vw, vh))
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)
  const k = Math.max(1, Math.min(2.5, Math.max(w, h) / 800))

  // Measured first, so the band is as tall as its text.
  const pad = Math.round(16 * k)
  const titleSize = Math.round(17 * k)
  const textSize = Math.round(14 * k)
  const font = (size: number, weight = 400) => `${weight} ${size}px "Geist Variable", system-ui, sans-serif`
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font(textSize)
  const repLine = repSpeeds.map((s, i) => `Rep ${i + 1}  ${s}`).join('   ·   ')
  const repLines = repLine ? wrap(measure, repLine, w - pad * 2) : []
  measure.font = font(textSize, 500)
  const noteLines = note?.trim() ? wrap(measure, note.trim(), w - pad * 2) : []
  const lineH = Math.round(textSize * 1.45)
  const band = pad * 2 + Math.round(titleSize * 1.4) + (repLines.length + noteLines.length) * lineH + (noteLines.length ? Math.round(lineH * 0.4) : 0)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h + band
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('Could not prepare the image.'))

  ctx.drawImage(video, 0, 0, w, h)
  const playhead = video.currentTime
  paintStrokes(ctx, strokes, scale, k, vh)
  paintPath(ctx, { path: track, reps, playhead, color, scale, k })
  const at = sampleAt(track, playhead)
  if (at) paintDot(ctx, at, color, scale, k)

  ctx.fillStyle = '#0c0d0f'
  ctx.fillRect(0, h, w, band)
  ctx.fillStyle = color
  ctx.fillRect(0, h, w, Math.max(2, Math.round(2 * k)))
  let y = h + pad
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ededf0'
  ctx.font = font(titleSize, 600)
  ctx.fillText(title, pad, y)
  y += Math.round(titleSize * 1.4)
  ctx.font = font(textSize)
  ctx.fillStyle = '#c4c4cc'
  for (const line of repLines) {
    ctx.fillText(line, pad, y)
    y += lineH
  }
  if (noteLines.length) {
    y += Math.round(lineH * 0.4)
    ctx.font = font(textSize, 500)
    ctx.fillStyle = '#ededf0'
    for (const line of noteLines) {
      ctx.fillText(line, pad, y)
      y += lineH
    }
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be made.'))), 'image/png'),
  )
}
