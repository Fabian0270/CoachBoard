import { useMemo } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { stickingPoint, type AngleVsBar } from 'coachboard-shared/pose'

// ---------------------------------------------------------------------------
// What the body was doing, against what the bar was doing (Feature 11e-6).
//
// This is the payoff the earlier phases were plumbing for. The two series
// already share a coordinate space and a clock, so there is no alignment step —
// they go on one x-axis and the coach can read "the knee stopped extending here,
// and that is where the bar stalled" directly off the picture.
//
// Bar velocity is drawn as SPEED, flipped positive. `vy` is image space so up is
// negative, and a chart where the good direction points down reads as a fault
// rather than as a rep.
// ---------------------------------------------------------------------------

/** Enough of a rise to be an ascent worth marking, in the chart's own units. */
const ANGLE_COLOR = '#22d3ee'
const HIP_COLOR = '#a78bfa'
const BAR_COLOR = '#facc15'

export default function JointAngleChart({
  series,
  calibrated,
}: {
  series: AngleVsBar[]
  /** Whether bar velocity is in m/s. Without a scale line it is px/s and unlabelled. */
  calibrated: boolean
}) {
  const { rows, stick, anyMetric, allMetric } = useMemo(() => {
    const stickIndex = stickingPoint(series)
    return {
      rows: series.map((s) => ({
        t: +s.t.toFixed(3),
        knee: s.knee,
        hip: s.hip,
        // Flipped so up-is-up. Nulls stay null so Recharts breaks the line
        // rather than drawing through a gap that was never measured.
        speed: s.barVelocity == null ? null : -s.barVelocity,
      })),
      stick: stickIndex == null ? null : +series[stickIndex].t.toFixed(3),
      anyMetric: series.some((s) => s.metric),
      allMetric: series.length > 0 && series.every((s) => s.metric),
    }
  }, [series])

  if (rows.length === 0) return null

  const speedUnit = calibrated ? 'm/s' : 'px/s'

  return (
    <div className="space-y-2">
      <div className="h-64 w-full">
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => `${v.toFixed(1)}s`}
              tick={{ fontSize: 11 }}
            />
            {/* Two axes because degrees and m/s share nothing but a clock. */}
            <YAxis
              yAxisId="angle"
              domain={[0, 180]}
              ticks={[0, 45, 90, 135, 180]}
              tick={{ fontSize: 11 }}
              width={38}
              label={{ value: '°', position: 'insideTopLeft', fontSize: 11 }}
            />
            <YAxis
              yAxisId="speed"
              orientation="right"
              tick={{ fontSize: 11 }}
              width={44}
              tickFormatter={(v: number) => v.toFixed(1)}
            />
            <Tooltip
              formatter={(value, name) => {
                const n = typeof value === 'number' ? value : Number(value)
                if (!Number.isFinite(n)) return ['—', String(name)]
                return name === 'Bar speed'
                  ? [`${n.toFixed(2)} ${speedUnit}`, String(name)]
                  : [`${Math.round(n)}°`, String(name)]
              }}
              labelFormatter={(v: number) => `${Number(v).toFixed(2)}s`}
              contentStyle={{ fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />

            {/* Where the bar was slowest on the way up. The whole question this
                chart answers is what the body was doing at this instant. */}
            {stick != null && (
              <ReferenceLine
                yAxisId="angle"
                x={stick}
                stroke="#f43f5e"
                strokeDasharray="4 3"
                label={{ value: 'sticking point', fontSize: 10, fill: '#f43f5e', position: 'top' }}
              />
            )}

            <Line
              yAxisId="angle"
              type="monotone"
              dataKey="knee"
              name="Knee"
              stroke={ANGLE_COLOR}
              dot={false}
              strokeWidth={2}
              connectNulls={false}
            />
            <Line
              yAxisId="angle"
              type="monotone"
              dataKey="hip"
              name="Hip"
              stroke={HIP_COLOR}
              dot={false}
              strokeWidth={2}
              connectNulls={false}
            />
            <Line
              yAxisId="speed"
              type="monotone"
              dataKey="speed"
              name="Bar speed"
              stroke={BAR_COLOR}
              dot={false}
              strokeWidth={2}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Said out loud, because it is the difference between an angle that is
          true of the body and one that is true of the camera's view of it. */}
      {!anyMetric ? (
        <p className="text-xs text-muted-foreground">
          Angles are measured from the picture rather than in three dimensions, so they are only
          reliable if the lift was filmed square-on to the way the joints move. Re-track this clip
          to get depth-aware angles.
        </p>
      ) : !allMetric ? (
        <p className="text-xs text-muted-foreground">
          Some frames fall back to flat, picture-based angles — those are the ones where a landmark
          was moved by hand.
        </p>
      ) : null}

      {!calibrated && (
        <p className="text-xs text-muted-foreground">
          Bar speed is in pixels/second — set the scale on this clip for m/s.
        </p>
      )}
    </div>
  )
}
