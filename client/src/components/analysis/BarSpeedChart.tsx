import { useMemo } from 'react'
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { repStickingPoints, verticalVelocity, type Sample } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// The bar's speed through the whole set (BP11): each rep's way up shaded, the
// playhead, and where each rep slowed most on the way up, with how far up it
// was. The speed curve used to be drawn only with a saved skeleton, and only
// on the saved page.
//
// Up is drawn positive, as in the joint-angle chart: `vy` is image space, and a
// chart where the lift points down reads as a fault.
// ---------------------------------------------------------------------------

const SPEED = 'hsl(var(--chart-4))'
const STICK = 'hsl(var(--destructive))'
const tick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' }

export default function BarSpeedChart({
  track,
  reps,
  pixelsPerMetre,
  currentTime,
  height = 200,
}: {
  track: Sample[]
  reps: { startT: number; endT: number }[]
  pixelsPerMetre: number | null
  currentTime?: number
  height?: number
}) {
  const metric = pixelsPerMetre != null && pixelsPerMetre > 0
  const unit = metric ? 'm/s' : 'px/s'
  const { rows, sticks, sorted } = useMemo(() => {
    const scale = metric ? pixelsPerMetre! : 1
    const order = [...reps].sort((a, b) => a.startT - b.startT)
    return {
      rows: verticalVelocity(track).map((v) => ({ t: v.t, speed: -v.vy / scale })),
      sticks: repStickingPoints(track, order).map((p) => (p ? { ...p, speed: p.speedPxS / scale } : null)),
      sorted: order,
    }
  }, [track, reps, metric, pixelsPerMetre])

  if (rows.length < 2) return null
  const fmt = (n: number) => (metric ? n.toFixed(2) : Math.round(n).toString())
  const stuck = sticks.map((p, i) => (p ? { ...p, rep: i + 1 } : null)).filter((p) => p !== null)

  return (
    <div className="space-y-2">
      <div style={{ height }} className="w-full" role="img" aria-label={`Bar speed over the set, in ${unit}`}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => `${v.toFixed(1)}s`}
              tick={tick}
              stroke="hsl(var(--border))"
              tickLine={false}
            />
            <YAxis tick={tick} stroke="hsl(var(--border))" tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => fmt(v)} />
            <Tooltip
              formatter={(value) => [`${fmt(Number(value))} ${unit}`, 'Bar speed']}
              labelFormatter={(v) => `${Number(v).toFixed(2)}s`}
              contentStyle={{
                background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8,
                fontSize: 12, color: 'hsl(var(--popover-foreground))',
              }}
              labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
              cursor={{ stroke: 'hsl(var(--border))' }}
            />
            {/* Each rep's way up, numbered. */}
            {sorted.map((r, i) => (
              <ReferenceArea
                key={i}
                x1={r.startT}
                x2={r.endT}
                fill="hsl(var(--primary))"
                fillOpacity={0.1}
                stroke="none"
                ifOverflow="extendDomain"
                label={{ value: `${i + 1}`, position: 'insideTop', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              />
            ))}
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Line type="monotone" dataKey="speed" stroke={SPEED} strokeWidth={2} dot={false} isAnimationActive={false} />
            {stuck.map((p) => (
              <ReferenceDot
                key={p.rep}
                x={p.t}
                y={p.speed}
                r={4}
                fill={STICK}
                stroke="hsl(var(--background))"
                label={{ value: `${Math.round(p.height * 100)}%`, position: 'top', fontSize: 10, fill: STICK }}
              />
            ))}
            {currentTime != null && <ReferenceLine x={currentTime} stroke="hsl(var(--foreground))" strokeOpacity={0.6} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        {stuck.length > 0 ? (
          <>
            Red dots: where a rep slowed most on the way up, as a share of the way from the bottom to the top —{' '}
            {stuck.map((p) => `rep ${p.rep} at ${Math.round(p.height * 100)}%`).join(', ')}.
            {stuck.length < sorted.length && ' The other reps sped up and slowed into lockout without a dip.'}
          </>
        ) : (
          'No rep slowed down and sped up again on the way up — no sticking point.'
        )}
        {!metric && ' Speed is in pixels/second — set the scale on this clip for m/s.'}
      </p>
    </div>
  )
}
