import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { AthleteProgress as Progress, ProgressE1RMPoint } from 'coachboard-shared'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import {
  bestRepVelocity, defaultVelocityMetric, isVbtLift, liftLabel,
  VELOCITY_METRIC_LABEL, type VbtLift, type VelocityMetric,
} from 'coachboard-shared/vbt'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Badge } from './ui/badge'
import LoadError from './LoadError'
import { errorMessage, getJson, getList } from '../lib/api'
import { kgTicks } from '../pages/ProgramReport'
import { velocityPrTimeline, type VelocityPrEvent } from './analysis/setHistory'
import { readSessions, sessionMvt, SLOW_SESSION, type SessionReading } from 'coachboard-shared/vbtSession'

// ---------------------------------------------------------------------------
// The athlete's progress across every block (I1): e1RM of the competition
// lifts week by week, the PRs recorded, and the bar speed of saved sets.
// The program report shows one block; this shows how the blocks join up.
// ---------------------------------------------------------------------------

const LIFT_COLORS: Record<string, string> = {
  squat: 'hsl(var(--chart-1))',
  bench: 'hsl(var(--chart-2))',
  deadlift: 'hsl(var(--chart-3))',
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' })

const tooltipStyle = {
  contentStyle: {
    background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8,
    fontSize: 12, color: 'hsl(var(--popover-foreground))',
  },
  labelStyle: { color: 'hsl(var(--muted-foreground))' },
  cursor: { stroke: 'hsl(var(--border))' },
}
const axisTick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' }
const numTick = { ...axisTick, fontFamily: 'Geist Mono Variable, ui-monospace, monospace' }

function E1RMChart({ points, color, unit }: { points: ProgressE1RMPoint[]; color: string; unit: string }) {
  const ticks = kgTicks(points.map((p) => p.e1rm))
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={points} margin={{ top: 12, right: 20, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="week" tickFormatter={shortDate} tick={axisTick} stroke="hsl(var(--border))" tickLine={false} padding={{ left: 16, right: 16 }} />
        <YAxis ticks={ticks} domain={[ticks[0], ticks[ticks.length - 1]]} tick={numTick} stroke="hsl(var(--border))" tickLine={false} axisLine={false} width={40} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(_l, payload) => {
            const p = payload?.[0]?.payload as ProgressE1RMPoint | undefined
            return p ? `${shortDate(p.date)} · ${p.programName}` : ''
          }}
          formatter={(value, _n, item) => {
            const p = item.payload as ProgressE1RMPoint
            return [`${value} ${unit}  (${p.weight} ${unit} × ${p.reps} @ ${p.rpe}, ${p.exerciseName})`, 'e1RM']
          }}
        />
        <Line type="monotone" dataKey="e1rm" stroke={color} strokeWidth={2} dot={{ r: 3.5 }} activeDot={{ r: 5.5 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

interface SpeedPoint { date: string; velocity: number; load: number | null }

/** Each saved set's fastest rep, per lift, oldest first. */
function speedByLift(rows: VideoAnalysisDto[]): { lift: VbtLift; metric: VelocityMetric; points: SpeedPoint[] }[] {
  const out = new Map<VbtLift, { lift: VbtLift; metric: VelocityMetric; points: SpeedPoint[] }>()
  for (const row of rows) {
    if (!isVbtLift(row.lift) || row.lift === 'other') continue
    // One measure per lift, so the line compares like with like.
    const metric = defaultVelocityMetric(row.lift)
    const v = bestRepVelocity(row.metrics ?? [], metric)
    if (v == null) continue
    const entry = out.get(row.lift) ?? { lift: row.lift, metric, points: [] }
    entry.points.push({ date: row.createdAt.slice(0, 10), velocity: Math.round(v * 100) / 100, load: row.loadKg })
    out.set(row.lift, entry)
  }
  return [...out.values()].map((e) => ({ ...e, points: e.points.sort((a, b) => a.date.localeCompare(b.date)) }))
}

/** unit is the athlete's (S3): every load here is in it. */
export default function AthleteProgress({ athleteId, unit = 'kg' }: { athleteId: string; unit?: string }) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [speed, setSpeed] = useState<ReturnType<typeof speedByLift> | null>(null)
  const [speedError, setSpeedError] = useState<string | null>(null)
  const [velocityPrs, setVelocityPrs] = useState<VelocityPrEvent[]>([])
  const [sessions, setSessions] = useState<SessionReading[]>([])

  const load = useCallback(() => {
    setError(null)
    getJson<Progress>(`/api/athletes/${encodeURIComponent(athleteId)}/progress`)
      .then(setProgress)
      .catch((e) => { setProgress(null); setError(errorMessage(e)) })
    setSpeedError(null)
    getList<VideoAnalysisDto>(`/api/analysis?athleteId=${encodeURIComponent(athleteId)}&withTrack=0`)
      .then(async (rows) => {
        setSpeed(speedByLift(rows))
        setVelocityPrs(velocityPrTimeline(rows))
        // Sessions (BP33, D59): each day's estimated max against the usual,
        // read with the athlete's stored 1RM speed like the saved page does.
        const stored = await getJson<Record<string, number>>(`/api/athletes/${encodeURIComponent(athleteId)}/mvt`).catch(() => ({} as Record<string, number>))
        const lifts = [...new Set(rows.map((r) => r.lift).filter((l): l is VbtLift => isVbtLift(l) && l !== 'other'))]
        setSessions(lifts.flatMap((l) => readSessions(rows, l, sessionMvt(l, stored[l])).filter((s) => s.todayMax != null)).sort((a, b) => b.day.localeCompare(a.day)))
      })
      .catch((e) => { setSpeed(null); setVelocityPrs([]); setSessions([]); setSpeedError(errorMessage(e)) })
  }, [athleteId])
  useEffect(() => { load() }, [load])

  if (error) return <LoadError what="this athlete's progress" message={error} onRetry={load} />
  if (!progress) return <div className="text-sm text-muted-foreground">Loading progress…</div>

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Estimated 1RM across blocks</CardTitle>
          <p className="text-sm text-muted-foreground">
            The best logged set of each week, competition lifts only, from every program.
          </p>
        </CardHeader>
        <CardContent className="space-y-8">
          {progress.e1rm.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing logged on the competition lifts yet. Import an athlete&apos;s results into a program to see this.
            </p>
          ) : progress.e1rm.map((lift) => {
            const first = lift.points[0]
            const latest = lift.points[lift.points.length - 1]
            const best = Math.max(...lift.points.map((p) => p.e1rm))
            const change = Math.round((latest.e1rm - first.e1rm) * 10) / 10
            return (
              <div key={lift.liftKey}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{lift.displayName}</span>
                  <Badge variant="outline">Best {best} {unit}</Badge>
                  <Badge variant="outline">Latest {latest.e1rm} {unit}</Badge>
                  {lift.points.length > 1 && (
                    <span className={`num text-sm ${change >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {change >= 0 ? '+' : ''}{change} {unit} since {shortDate(first.week)}
                    </span>
                  )}
                </div>
                {lift.points.length > 1 ? (
                  <E1RMChart points={lift.points} color={LIFT_COLORS[lift.liftKey]} unit={unit} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    One week so far: {latest.e1rm} {unit} on {shortDate(latest.date)} (
                    <Link to={`/programs/${latest.programId}`} className="hover:text-primary">{latest.programName}</Link>).
                  </p>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>PRs</CardTitle></CardHeader>
        <CardContent>
          {progress.prs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No maxes recorded yet. They are kept under Maxes &amp; RPE.</p>
          ) : (
            <table className="w-full text-sm" aria-label="PR timeline">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-6 font-medium">Date</th>
                  <th className="pb-2 pr-6 font-medium">Lift</th>
                  <th className="pb-2 pr-6 font-medium">Max</th>
                  <th className="pb-2 font-medium">Up by</th>
                </tr>
              </thead>
              <tbody>
                {progress.prs.map((pr, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="num py-1.5 pr-6">{shortDate(pr.date)}</td>
                    <td className="py-1.5 pr-6">{pr.liftName}</td>
                    <td className="num py-1.5 pr-6 font-medium">{pr.weight} {pr.unit}</td>
                    <td className="num py-1.5 text-success">
                      {pr.previous === null ? <span className="text-muted-foreground">first</span> : `+${Math.round((pr.weight - pr.previous) * 10) / 10} ${pr.unit}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* Velocity PRs from saved bar path sets (BP35): the fastest set at a
              load so far, the same rule as the saved page's badge. */}
          {velocityPrs.length > 0 && (
            <table className="mt-6 w-full text-sm" aria-label="Velocity PRs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-6 font-medium">Date</th>
                  <th className="pb-2 pr-6 font-medium">Velocity PR</th>
                  <th className="pb-2 pr-6 font-medium">Fastest rep</th>
                  <th className="pb-2 font-medium">Up by</th>
                </tr>
              </thead>
              <tbody>
                {velocityPrs.map((pr) => (
                  <tr key={pr.id} className="border-b last:border-0">
                    <td className="num py-1.5 pr-6">{shortDate(pr.date)}</td>
                    <td className="py-1.5 pr-6">
                      <Link to={`/analysis/saved/${pr.id}`} className="hover:text-primary">
                        {isVbtLift(pr.lift) ? liftLabel(pr.lift) : pr.lift} {pr.loadKg} {unit}
                      </Link>
                    </td>
                    <td className="num py-1.5 pr-6 font-medium">{pr.best.toFixed(2)} m/s</td>
                    <td className="num py-1.5 text-success">+{(pr.best - pr.previous).toFixed(2)} m/s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bar speed</CardTitle>
          <p className="text-sm text-muted-foreground">The fastest rep of each saved bar path set, with its load.</p>
        </CardHeader>
        <CardContent className="space-y-8">
          {speedError ? (
            <p className="text-sm text-destructive">Could not read the saved bar path sets. {speedError}</p>
          ) : !speed ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : speed.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bar path sets saved with a lift yet.</p>
          ) : speed.map((s) => (
            <div key={s.lift}>
              <div className="mb-3 flex items-center gap-2">
                <span className="font-semibold">{liftLabel(s.lift)}</span>
                <span className="text-xs text-muted-foreground">{VELOCITY_METRIC_LABEL[s.metric]}</span>
              </div>
              {s.points.length > 1 ? (
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={s.points} margin={{ top: 12, right: 20, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} stroke="hsl(var(--border))" tickLine={false} padding={{ left: 16, right: 16 }} />
                    <YAxis tick={numTick} stroke="hsl(var(--border))" tickLine={false} axisLine={false} width={40} domain={['auto', 'auto']} />
                    <Tooltip
                      {...tooltipStyle}
                      labelFormatter={(l: string) => shortDate(l)}
                      formatter={(v, _n, item) => {
                        const p = item.payload as SpeedPoint
                        return [`${v} m/s${p.load != null ? ` at ${p.load} ${unit}` : ''}`, 'Fastest rep']
                      }}
                    />
                    <Line type="monotone" dataKey="velocity" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={{ r: 3.5 }} activeDot={{ r: 5.5 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-muted-foreground">
                  One set so far: {s.points[0].velocity} m/s{s.points[0].load != null ? ` at ${s.points[0].load} ${unit}` : ''} on {shortDate(s.points[0].date)}.
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Sessions (BP33, D59): each day with three or more bar path sets of a
          lift on a clear line, today's estimated max against the usual. */}
      {sessions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Sessions</CardTitle>
            <p className="text-sm text-muted-foreground">
              Days with three or more saved sets of a lift: that day&rsquo;s estimated max from the sets, against the usual (the middle of the other days).
            </p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm" aria-label="Sessions">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-6 font-medium">Date</th>
                  <th className="pb-2 pr-6 font-medium">Lift</th>
                  <th className="pb-2 pr-6 font-medium">Sets</th>
                  <th className="pb-2 pr-6 font-medium">Today&rsquo;s max</th>
                  <th className="pb-2 font-medium">Against the usual</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={`${s.lift}:${s.day}`} className="border-b last:border-0">
                    <td className="num py-1.5 pr-6">{shortDate(s.day)}</td>
                    <td className="py-1.5 pr-6">{liftLabel(s.lift)}</td>
                    <td className="num py-1.5 pr-6">{s.sets}</td>
                    <td className="num py-1.5 pr-6 font-medium">{Math.round(s.todayMax! * 2) / 2} {unit}</td>
                    <td className={`num py-1.5 ${s.vsUsual != null && s.vsUsual <= -SLOW_SESSION ? 'text-warning' : 'text-muted-foreground'}`}>
                      {s.vsUsual == null ? '—' : `${s.vsUsual >= 0 ? '+' : '−'}${Math.abs(Math.round(s.vsUsual * 100))} %`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
