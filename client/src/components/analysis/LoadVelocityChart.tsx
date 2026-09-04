import { useMemo } from 'react'
import {
  CartesianGrid,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { LoadVelocityProfile } from 'coachboard-shared/vbt'

/**
 * The profile as a picture: one dot per tracked set, the fitted line through
 * them, extended to where it crosses the minimum velocity threshold.
 *
 * That crossing IS the estimated 1RM, so drawing the line all the way to it
 * shows the coach how much of the estimate is measurement and how much is
 * extrapolation — which a bare "1RM: 205 kg" never could.
 */
export default function LoadVelocityChart({ profile }: { profile: LoadVelocityProfile }) {
  const { line, dots, domain } = useMemo(() => {
    const loads = profile.points.map((p) => p.load)
    const minLoad = Math.min(...loads)
    // Run the line out to the projected max where there is one, so the gap
    // between the heaviest real set and the estimate is visible.
    const maxLoad = Math.max(...loads, profile.oneRm ?? 0)
    const pad = Math.max(5, (maxLoad - minLoad) * 0.08)
    const from = Math.max(0, minLoad - pad)
    // Never run past where the fit predicts a standstill — the line is only
    // meaningful while it predicts a bar that still moves.
    const zeroAt = profile.fit.slope < 0 ? -profile.fit.intercept / profile.fit.slope : Infinity
    const to = Math.min(maxLoad + pad, zeroAt)

    // Straight from the fit rather than through velocityForLoad, which nulls out
    // rather than returning a non-positive velocity — a null here would silently
    // truncate the line instead of ending it at the axis.
    const at = (load: number) => profile.fit.intercept + profile.fit.slope * load

    return {
      dots: profile.points.map((p) => ({ load: p.load, measured: p.velocity, label: p.label })),
      line: [
        { load: from, fitted: at(from) },
        { load: to, fitted: at(to) },
      ],
      domain: [from, to] as [number, number],
    }
  }, [profile])

  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            type="number"
            dataKey="load"
            domain={domain}
            tick={{ fontSize: 12 }}
            unit=" kg"
            allowDecimals={false}
          />
          <YAxis
            type="number"
            dataKey="measured"
            domain={[0, 'auto']}
            width={54}
            tick={{ fontSize: 12 }}
            unit=" m/s"
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--background))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: number, name) => [
              `${value.toFixed(2)} m/s`,
              name === 'fitted' ? 'Profile' : 'Tracked set',
            ]}
            labelFormatter={(load: number) => `${Math.round(load)} kg`}
          />
          {/* The fitted line is data, not a reference marker, so it carries the
              MVT crossing with it when the profile is refitted. */}
          <Line
            data={line}
            dataKey="fitted"
            type="linear"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Scatter data={dots} dataKey="measured" fill="hsl(var(--primary))" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
