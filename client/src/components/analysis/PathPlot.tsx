import { useEffect, useRef } from 'react'
import type { Sample } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// The bar path on its own, with no video behind it.
//
// A saved analysis keeps the whole tracked path, so the trajectory can be
// redrawn from the database alone — which is what makes a locally imported clip
// reopenable at all. The file never left the coach's computer and still does
// not have to: the shape of the path, which is most of what bar path analysis
// is for, was never in the video anyway.
//
// Image coordinates and canvas coordinates both grow downward, so the path is
// drawn as-is and comes out the right way up.
// ---------------------------------------------------------------------------

interface Props {
  track: Sample[]
  color: string
  /** Pixels per metre, to label the plot in real units where it is known. */
  pixelsPerMetre?: number | null
  height?: number
}

export default function PathPlot({ track, color, pixelsPerMetre, height = 260 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || track.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Match the backing store to the displayed size so the line is not blurry
    // on a high-DPI screen.
    const dpr = window.devicePixelRatio || 1
    const cssWidth = canvas.clientWidth
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, height)

    const xs = track.map((s) => s.x)
    const ys = track.map((s) => s.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // Uniform scale on both axes. Stretching one would exaggerate the sideways
    // drift, which is the single thing a coach reads off this picture.
    const pad = 24
    const spanX = Math.max(maxX - minX, 1)
    const spanY = Math.max(maxY - minY, 1)
    const scale = Math.min((cssWidth - pad * 2) / spanX, (height - pad * 2) / spanY)
    const offsetX = (cssWidth - spanX * scale) / 2
    const offsetY = (height - spanY * scale) / 2
    const px = (s: Sample) => ({
      x: offsetX + (s.x - minX) * scale,
      y: offsetY + (s.y - minY) * scale,
    })

    // A vertical guide through the start, so drift away from it is visible.
    const start = px(track[0])
    ctx.strokeStyle = 'rgba(128,128,128,0.35)'
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(start.x, offsetY)
    ctx.lineTo(start.x, offsetY + spanY * scale)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    track.forEach((s, i) => {
      const p = px(s)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.stroke()

    // Where it began and where it ended, so the direction is not a guess.
    const end = px(track[track.length - 1])
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(start.x, start.y, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(end.x, end.y, 4, 0, Math.PI * 2)
    ctx.fill()
  }, [track, color, height])

  if (track.length < 2) {
    return <p className="text-sm text-muted-foreground">No path was saved with this analysis.</p>
  }

  const xs = track.map((s) => s.x)
  const driftPx = Math.max(...xs) - Math.min(...xs)
  const driftCm = pixelsPerMetre ? (driftPx / pixelsPerMetre) * 100 : null

  return (
    <div className="space-y-1">
      <canvas ref={canvasRef} style={{ width: '100%', height }} className="rounded-md border" />
      <p className="text-xs text-muted-foreground">
        Sideways travel {driftCm != null ? `${driftCm.toFixed(1)} cm` : `${Math.round(driftPx)} px`}{' '}
        against the dashed line through the start. Both axes share one scale, so the drift is not
        exaggerated.
      </p>
    </div>
  )
}
