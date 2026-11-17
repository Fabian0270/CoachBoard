import { useEffect, useMemo, useRef } from 'react'
import type { Sample } from 'coachboard-shared/videoAnalysis'
import { repWindows } from './AnalysisStage'

// ---------------------------------------------------------------------------
// Two sets' paths on one plot (BP26), each laid over its own reps from one
// common start, in its own colour.
//
// In real units only. Two clips are almost never filmed at the same zoom, so
// laying pixel paths over each other would make one lift look twice the size
// of the other; without a scale on both sides the plot says so instead.
// ---------------------------------------------------------------------------

export interface CompareSide {
  label: string
  color: string
  track: Sample[]
  reps: { startT: number; endT: number }[]
  pixelsPerMetre: number | null
}

/** Each rep (or the whole path, for a set with none) as points in metres from its own start. */
function segments(side: CompareSide) {
  const ppm = side.pixelsPerMetre!
  const windows = side.reps.length && side.track.length > 1
    ? repWindows(side.reps, side.track[0].t)
    : side.track.length > 1 ? [{ from: side.track[0].t, bottom: side.track[0].t, to: side.track[side.track.length - 1].t }] : []
  return windows.map((w) => {
    const pts = side.track.filter((s) => s.t >= w.from && s.t <= w.to)
    const o = pts[0]
    return { w, pts: o ? pts.map((s) => ({ t: s.t, x: (s.x - o.x) / ppm, y: (s.y - o.y) / ppm })) : [] }
  }).filter((s) => s.pts.length > 1)
}

export default function ComparePathPlot({ sides, focusRep = null, focus, height = 320 }: {
  sides: [CompareSide, CompareSide]
  /** A rep to pick out on both sides (0-based); the rest are dimmed. */
  focusRep?: number | null
  /** A rep to pick out on each side separately (BP37: rep 1 against the last); wins over focusRep. */
  focus?: [number | null, number | null]
  height?: number
}) {
  const picked: [number | null, number | null] = focus ?? [focusRep, focusRep]
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const scaled = sides.every((s) => s.pixelsPerMetre != null && s.pixelsPerMetre > 0)
  const segs = useMemo(() => (scaled ? sides.map(segments) : null), [sides, scaled])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !segs) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const cssWidth = canvas.clientWidth
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, height)

    const all = segs.flat().flatMap((s) => s.pts)
    if (all.length < 2) return
    const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x))
    const minY = Math.min(...all.map((p) => p.y)), maxY = Math.max(...all.map((p) => p.y))
    const pad = 20
    const spanX = Math.max(maxX - minX, 0.01), spanY = Math.max(maxY - minY, 0.01)
    // One scale for both axes and both sets: drift is not exaggerated, and a
    // longer range of motion really is drawn longer.
    const scale = Math.min((cssWidth - pad * 2) / spanX, (height - pad * 2) / spanY)
    const ox = (cssWidth - spanX * scale) / 2 - minX * scale
    const oy = (height - spanY * scale) / 2 - minY * scale

    ctx.strokeStyle = 'rgba(128,128,128,0.35)'
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(ox, oy + minY * scale)
    ctx.lineTo(ox, oy + maxY * scale)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    const line = (pts: { x: number; y: number }[]) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * scale, oy + p.y * scale) : ctx.moveTo(ox + p.x * scale, oy + p.y * scale)))
      ctx.stroke()
    }
    segs.forEach((side, si) => {
      ctx.strokeStyle = sides[si].color
      side.forEach(({ w, pts }, i) => {
        const on = picked[si] == null || i === picked[si]
        ctx.globalAlpha = on ? 0.5 : 0.12
        ctx.lineWidth = on ? 2 : 1.5
        line(pts.filter((p) => p.t <= w.bottom))
        ctx.globalAlpha = on ? 1 : 0.25
        ctx.lineWidth = on ? 3 : 1.5
        line(pts.filter((p) => p.t >= w.bottom))
      })
    })
    ctx.globalAlpha = 1
  }, [segs, sides, picked[0], picked[1], height]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!scaled) {
    return (
      <p className="text-sm text-muted-foreground">
        Both paths go on one plot once both sets have a scale: two clips are rarely filmed at the
        same zoom, so pixels would make one lift look bigger than the other. Set the scale on the
        Bar path page and save the set again.
      </p>
    )
  }
  return (
    <div className="space-y-1">
      <canvas ref={canvasRef} style={{ width: '100%', height }} className="rounded-md border" aria-label="Both paths on one plot" role="img" />
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {sides.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2 w-4 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
        <span>
          Each set&rsquo;s reps from one start
          {picked[0] != null && picked[0] === picked[1] ? `, rep ${picked[0] + 1} picked out` : ''}
          {picked[0] != null && picked[1] != null && picked[0] !== picked[1] ? `, rep ${picked[0] + 1} on the left against rep ${picked[1] + 1} on the right` : ''}
          ; the way down is lighter. Real units on both axes.
        </span>
      </p>
    </div>
  )
}
