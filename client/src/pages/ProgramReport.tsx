import { Fragment, useEffect, useMemo, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { TrendingUp, CheckCircle2, Sparkles } from 'lucide-react'
import PageHeader, { BackLink } from '../components/PageHeader'
import type { ProgramReport } from 'coachboard-shared'
import type { Program } from '../lib/programUtils'
import { SuggestProgramDialog } from '../components/suggest-program/SuggestProgramDialog'
import { useToast } from '../components/ui/toast'
import LoadError from '../components/LoadError'
import { ApiError, errorMessage, getJson, getList } from '../lib/api'
import { barSpeedSets, type BarSpeedSet } from '../lib/barSpeedReport'
import { shortDay } from '../components/analysis/TrainingDayLink'
import { unitOf, type LoadUnit } from 'coachboard-shared/units'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import { localToday } from '../lib/dates'
import { computeVolume, VOLUME_LABELS, VOLUME_LIFTS, type VolumeLift } from '../lib/volume'

const LIFT_COLORS: Record<string, string> = {
  squat: 'hsl(var(--chart-1))',
  bench: 'hsl(var(--chart-2))',
  deadlift: 'hsl(var(--chart-3))',
}

/**
 * Evenly spaced, round y-axis ticks for an e1RM chart: steps of 1, 2, 5, 10…
 * whole kilos, about four intervals, bracketing every value. Left to Recharts,
 * the axis landed on uneven ticks like 171 / 168 / 166 / 164 or 169.05.
 */
export function kgTicks(values: number[], intervals = 4): number[] {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const raw = Math.max((hi - lo) / intervals, 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  let start = Math.floor(lo / step) * step
  let end = Math.ceil(hi / step) * step
  // A flat line would otherwise sit on the bottom edge with a single tick.
  if (start === end) { start -= step; end += step }
  const ticks: number[] = []
  for (let v = start; v <= end + step / 1000; v += step) ticks.push(Math.round(v))
  return ticks
}

function fmt(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

function deviationLabel(delta: number): string {
  if (delta > 0.4) return 'text-destructive'
  if (delta < -0.4) return 'text-info'
  return 'text-success'
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-GB')
const kg = (v: number) => Math.round(v).toLocaleString('en-GB')

/**
 * Weekly sets and tonnage per lift, done against planned (I3). Shown before
 * any results come in too: the planned side is useful on its own.
 */
function VolumeCard({ program, maxes, unit }: { program: Program; maxes: ProgramReport['storedMaxes']; unit: LoadUnit }) {
  const weeks = useMemo(() => computeVolume(program.workouts, program.start_date, maxes, unit), [program, maxes, unit])
  const lifts = VOLUME_LIFTS.filter((l) => weeks.some((w) => w.byLift[l].plannedSets > 0))
  if (lifts.length === 0) return null
  const total = (l: VolumeLift) => weeks.reduce((t, w) => {
    const c = w.byLift[l]
    return { plannedSets: t.plannedSets + c.plannedSets, doneSets: t.doneSets + c.doneSets, plannedKg: t.plannedKg + c.plannedKg, doneKg: t.doneKg + c.doneKg, estimated: t.estimated || c.estimated }
  }, { plannedSets: 0, doneSets: 0, plannedKg: 0, doneKg: 0, estimated: false })
  const anyEstimated = weeks.some((w) => lifts.some((l) => w.byLift[l].estimated))
  const cells = (c: ReturnType<typeof total>, strong = false) => (
    <>
      <td className={`num border-l py-1.5 pl-3 pr-2 ${strong ? 'font-semibold' : ''}`}>
        {n1(c.doneSets)} <span className="text-muted-foreground">/ {n1(c.plannedSets)}</span>
      </td>
      <td className={`num py-1.5 pr-3 ${strong ? 'font-semibold' : ''}`}>
        {c.plannedKg > 0 || c.doneKg > 0 ? (
          // A planned 0 means no planned load was known, not that none was planned.
          <>{kg(c.doneKg)} <span className="text-muted-foreground">/ {c.plannedKg > 0 ? `${c.estimated ? '≈' : ''}${kg(c.plannedKg)}` : '—'}</span></>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
    </>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Volume</CardTitle>
        <p className="text-sm text-muted-foreground">
          Sets and tonnage ({unit}) per week, done / planned. Squat, Bench and Deadlift are the competition lifts; every variation is under Other.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Volume per week">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th rowSpan={2} className="pb-2 pr-6 align-bottom font-medium">Week</th>
                {lifts.map((l) => <th key={l} colSpan={2} className="border-l pb-1 pl-3 font-semibold text-foreground">{VOLUME_LABELS[l]}</th>)}
              </tr>
              <tr className="border-b text-left text-xs text-muted-foreground">
                {lifts.map((l) => (
                  <Fragment key={l}>
                    <th className="border-l pb-2 pl-3 pr-2 font-medium">Sets</th>
                    <th className="pb-2 pr-3 font-medium">Tonnage</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.weekIndex} className="border-b">
                  <td className="py-1.5 pr-6">Wk {w.weekIndex + 1}</td>
                  {lifts.map((l) => <Fragment key={l}>{cells(w.byLift[l])}</Fragment>)}
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-6 font-semibold">Block</td>
                {lifts.map((l) => <Fragment key={l}>{cells(total(l), true)}</Fragment>)}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Done counts each logged row at its prescribed sets and reps with the load the athlete logged.
          {anyEstimated && ' ≈ includes suggested loads for rows with no Load Cap (from the max, or the set above for a back-off).'}
        </p>
      </CardContent>
    </Card>
  )
}

const LIFT_NAMES: Record<string, string> = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift' }

/**
 * Bar speed from the saved sets linked to this program's days (L2, D68): the
 * load, the fastest rep, and that day's estimated max from bar speed beside the
 * week's e1RM from logged sets. Never mixed into the e1RM above (D69).
 */
function BarSpeedCard({ program, trends, athleteId, unit }: { program: Program; trends: ProgramReport['e1rmTrends']; athleteId: string; unit: LoadUnit }) {
  const [sets, setSets] = useState<BarSpeedSet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    const aid = encodeURIComponent(athleteId)
    Promise.all([
      getList<VideoAnalysisDto>(`/api/analysis?athleteId=${aid}&withTrack=0`),
      getJson<Record<string, number>>(`/api/athletes/${aid}/mvt`).catch(() => ({} as Record<string, number>)),
    ])
      .then(([analyses, mvt]) => { if (!cancelled) { setSets(barSpeedSets(program, analyses, mvt, trends)); setError(null) } })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)) })
    return () => { cancelled = true }
  }, [program, trends, athleteId, attempt])

  if (error) return <LoadError what="the bar speed sets" message={error} onRetry={() => setAttempt((n) => n + 1)} />
  if (!sets || sets.length === 0) return null
  // The week's lift label and e1RM only on its first row.
  const firstOf = (i: number) => i === 0 || sets[i - 1].weekIndex !== sets[i].weekIndex || sets[i - 1].liftKey !== sets[i].liftKey
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bar speed</CardTitle>
        <p className="text-sm text-muted-foreground">
          Saved bar path sets linked to this program&rsquo;s days. The day&rsquo;s max is read from that day&rsquo;s sets,
          as on the Progress tab; the e1RM beside it is the week&rsquo;s from logged sets, and the two are kept apart.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Bar speed per week">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Week</th>
                <th className="pb-2 pr-4 font-medium">Lift</th>
                <th className="pb-2 pr-4 font-medium">Day</th>
                <th className="pb-2 pr-4 text-right font-medium">Load</th>
                <th className="pb-2 pr-4 text-right font-medium">Fastest rep</th>
                <th className="pb-2 pr-4 text-right font-medium">Day&rsquo;s max (bar speed)</th>
                <th className="pb-2 pr-4 text-right font-medium">Week e1RM (RPE)</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {sets.map((s, i) => (
                <tr key={s.analysisId} className={firstOf(i) ? 'border-t' : ''}>
                  <td className="py-1.5 pr-4">{firstOf(i) ? `Wk ${s.weekIndex + 1}` : ''}</td>
                  <td className="py-1.5 pr-4 font-medium">{firstOf(i) ? LIFT_NAMES[s.liftKey] : ''}</td>
                  <td className="py-1.5 pr-4 text-muted-foreground">
                    {shortDay(s.date)} · {s.workoutName}{s.exerciseName ? ` — ${s.exerciseName}` : ''}
                  </td>
                  <td className="num py-1.5 pr-4 text-right">{s.loadKg != null ? `${s.loadKg} ${unit}` : '—'}</td>
                  <td className="num py-1.5 pr-4 text-right">{s.speed != null ? `${s.speed.toFixed(2)} m/s` : '—'}</td>
                  <td className="num py-1.5 pr-4 text-right">{s.dayMax != null ? `${Math.round(s.dayMax)} ${unit}` : <span className="text-muted-foreground">—</span>}</td>
                  <td className="num py-1.5 pr-4 text-right">{firstOf(i) ? (s.rpeE1rm != null ? `${fmt(s.rpeE1rm)} ${unit}` : <span className="text-muted-foreground">—</span>) : ''}</td>
                  <td className="py-1.5 text-right">
                    <Link to={`/analysis/saved/${s.analysisId}`} className="text-xs text-primary underline-offset-2 hover:underline">Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          A day&rsquo;s max needs at least three sets of the lift that day with a clear load-speed line; — means there were too few.
        </p>
      </CardContent>
    </Card>
  )
}

export default function ProgramReport() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [report, setReport] = useState<ProgramReport | null>(null)
  const [program, setProgram] = useState<Program | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  const [updatingMax, setUpdatingMax] = useState<Set<string>>(new Set())
  const [updatedMax, setUpdatedMax] = useState<Set<string>>(new Set())
  const [suggestOpen, setSuggestOpen] = useState(false)

  const [attempt, setAttempt] = useState(0)
  const [notFound, setNotFound] = useState(false)

  // A 500 used to be stored as the report and crash the page on the first
  // field it read; a 404 did the same.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)
    const pid = encodeURIComponent(id)
    Promise.all([
      getJson<ProgramReport>(`/api/programs/${pid}/report`),
      getJson<Program>(`/api/programs/${pid}`),
    ])
      .then(([rep, prog]) => {
        if (cancelled) return
        setReport(rep)
        setProgram(prog)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 404) setNotFound(true)
        else setError(errorMessage(e))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, attempt])

  const handleUpdateMax = async (liftKey: string, displayName: string, e1rm: number) => {
    if (!report?.athleteId) return
    setUpdatingMax((prev) => new Set([...prev, liftKey]))
    try {
      const res = await fetch(`/api/athletes/${report.athleteId}/maxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lift_name: displayName,
          weight: e1rm,
          unit,
          recorded_at: localToday(),
          notes: 'Estimated 1RM from program analysis',
        }),
      })
      // A refusal used to do nothing at all: the button stopped spinning and the
      // coach could not tell a saved max from a lost one.
      if (res.ok) setUpdatedMax((prev) => new Set([...prev, liftKey]))
      else toast.error(`Could not save the new ${displayName} max (the server said ${res.status}).`)
    } catch {
      toast.error(`Could not save the new ${displayName} max — CoachBoard could not reach its own server.`)
    } finally {
      setUpdatingMax((prev) => {
        const s = new Set(prev)
        s.delete(liftKey)
        return s
      })
    }
  }

  if (loading) return <div className="text-muted-foreground">Loading report...</div>
  if (error) return <LoadError what="the report" message={error} onRetry={() => setAttempt((n) => n + 1)} />
  if (notFound || !report || !program) return <div className="text-muted-foreground">Report not found.</div>

  // The unit the program's loads are in (S3): its athlete's.
  const unit = unitOf(program.unit)
  const hasData = report.exercisesCompleted > 0
  const completionPct = Math.round(report.completionRate * 100)
  const hasRpeDeviation = report.rpeDeviations.some((r) => r.delta !== null)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BackLink to={`/programs/${id}`}>{program.name}</BackLink>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            Program Report
            <Badge variant={program.status === 'completed' ? 'secondary' : 'default'} className="capitalize">
              {program.status}
            </Badge>
            {program.focus && <Badge variant="outline" className="capitalize">{program.focus}</Badge>}
          </span>
        }
        actions={
          report.athleteId && (program.status === 'completed' || program.status === 'archived') ? (
            <Button variant="outline" size="sm" onClick={() => setSuggestOpen(true)}>
              <Sparkles className="h-4 w-4" />
              Generate next program
            </Button>
          ) : undefined
        }
      />

      {id && report.athleteId && (
        <SuggestProgramDialog
          open={suggestOpen}
          onOpenChange={setSuggestOpen}
          programId={id}
          athleteId={report.athleteId}
          onCreated={(draftId) => navigate(`/programs/${draftId}`)}
        />
      )}

      {/* Stats row */}
      <div data-tour="program-report" className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{completionPct}%</div>
            <div className="text-sm text-muted-foreground mt-1">Completion rate</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {report.exercisesCompleted} / {report.exercisesTotal} exercises logged
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{report.e1rmTrends.length}</div>
            <div className="text-sm text-muted-foreground mt-1">Main lifts tracked</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {report.e1rmTrends.map((t) => t.displayName).join(', ') || '—'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">
              {report.avgRpeDeviation !== null
                ? `${report.avgRpeDeviation > 0 ? '+' : ''}${fmt(report.avgRpeDeviation)}`
                : '—'}
            </div>
            <div className="text-sm text-muted-foreground mt-1">Avg RPE deviation</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {report.avgRpeDeviation !== null
                ? report.avgRpeDeviation > 0.5
                  ? 'Program was too heavy'
                  : report.avgRpeDeviation < -0.5
                    ? 'Program was too light'
                    : 'On target'
                : 'No prescribed RPE in intensity field'}
            </div>
          </CardContent>
        </Card>
      </div>

      <VolumeCard program={program} maxes={report.storedMaxes} unit={unit} />

      {report.athleteId && <BarSpeedCard program={program} trends={report.e1rmTrends} athleteId={report.athleteId} unit={unit} />}

      {!hasData ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <TrendingUp className="h-12 w-12 mx-auto mb-3 opacity-30" />
            {program.status === 'active' ? (
              <>
                <p className="font-medium">No results yet</p>
                <p className="text-sm mt-1">
                  Import the filled Excel sheet to see e1RM trends and RPE analysis.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">No analysis available</p>
                <p className="text-sm mt-1">
                  This program has no load or RPE data, so e1RM trends can’t be computed.
                </p>
              </>
            )}
            <Button variant="outline" size="sm" className="mt-4" asChild>
              <Link to={`/programs/${id}`}>Back to program</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* e1RM Trends */}
          {report.e1rmTrends.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Estimated 1RM Trends</CardTitle>
              </CardHeader>
              <CardContent className="space-y-8">
                {report.e1rmTrends.map((trend) => (
                  <div key={trend.liftKey}>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="font-semibold">{trend.displayName}</span>
                      <Badge variant="outline">Best {fmt(trend.bestE1RM)} {unit}</Badge>
                      <Badge variant="outline">Latest {fmt(trend.latestE1RM)} {unit}</Badge>
                    </div>
                    {trend.dataPoints.length > 1 ? (
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart
                          data={trend.dataPoints}
                          margin={{ top: 12, right: 20, left: 0, bottom: 4 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="hsl(var(--border))"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="weekIndex"
                            tickFormatter={(w: number) => `Wk ${w + 1}`}
                            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                            stroke="hsl(var(--border))"
                            tickLine={false}
                            padding={{ left: 16, right: 16 }}
                          />
                          {/* No per-tick "kg": at this width it wrapped every label onto
                              two lines and clipped the top one. The badges above say the unit. */}
                          <YAxis
                            {...(() => {
                              const ticks = kgTicks(trend.dataPoints.map((d) => d.e1rm))
                              return { ticks, domain: [ticks[0], ticks[ticks.length - 1]] as [number, number] }
                            })()}
                            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))', fontFamily: 'Geist Mono Variable, ui-monospace, monospace' }}
                            stroke="hsl(var(--border))"
                            tickLine={false}
                            axisLine={false}
                            width={40}
                          />
                          <Tooltip
                            formatter={(value: number) => [`${value} ${unit}`, 'e1RM']}
                            labelFormatter={(label: number) => `Week ${label + 1}`}
                            contentStyle={{
                              background: 'hsl(var(--popover))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: 8,
                              fontSize: 12,
                              color: 'hsl(var(--popover-foreground))',
                            }}
                            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                            cursor={{ stroke: 'hsl(var(--border))' }}
                          />
                          <Line
                            type="monotone"
                            dataKey="e1rm"
                            stroke={LIFT_COLORS[trend.liftKey] ?? 'hsl(var(--muted-foreground))'}
                            strokeWidth={2}
                            dot={{ r: 4 }}
                            activeDot={{ r: 6 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Only one data point — {fmt(trend.dataPoints[0]?.e1rm)} {unit}
                        (Week {(trend.dataPoints[0]?.weekIndex ?? 0) + 1})
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Training Max Comparison */}
          {report.e1rmTrends.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Training Max Comparison</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {report.e1rmTrends.map((trend) => {
                    if (trend.latestE1RM === null) return null
                    const storedMax = report.storedMaxes.find((m) =>
                      m.lift_name.toLowerCase().includes(trend.liftKey),
                    )
                    const alreadyUpdated = updatedMax.has(trend.liftKey)
                    const isUpdating = updatingMax.has(trend.liftKey)
                    const canUpdate = trend.latestE1RM > (storedMax?.weight ?? 0)

                    return (
                      <div
                        key={trend.liftKey}
                        className="flex items-center justify-between py-3 border-b last:border-0"
                      >
                        <div>
                          <span className="font-medium">{trend.displayName}</span>
                          <div className="text-sm text-muted-foreground mt-0.5">
                            {storedMax
                              ? `Stored max: ${storedMax.weight} ${storedMax.unit}  →  e1RM this block: ${fmt(trend.latestE1RM)} ${unit}`
                              : `No stored max  →  e1RM this block: ${fmt(trend.latestE1RM)} ${unit}`}
                          </div>
                        </div>
                        {!report.athleteId ? (
                          <span className="text-sm text-muted-foreground">Assign an athlete to save PRs</span>
                        ) : alreadyUpdated ? (
                          <div className="flex items-center gap-1.5 text-sm text-success">
                            <CheckCircle2 className="h-4 w-4" />
                            Saved
                          </div>
                        ) : canUpdate ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isUpdating}
                            onClick={() =>
                              handleUpdateMax(
                                trend.liftKey,
                                trend.displayName,
                                trend.latestE1RM!,
                              )
                            }
                          >
                            {isUpdating ? 'Saving…' : `Set PR to ${fmt(trend.latestE1RM)} ${unit}`}
                          </Button>
                        ) : (
                          <span className="text-sm text-muted-foreground">At or below max</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* RPE Analysis */}
          {report.rpeDeviations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>RPE Log</CardTitle>
              </CardHeader>
              <CardContent>
                {hasRpeDeviation && report.avgRpeDeviation !== null && (
                  <p className="text-sm text-muted-foreground mb-4">
                    Average deviation from prescribed RPE:{' '}
                    <strong>
                      {report.avgRpeDeviation > 0 ? '+' : ''}
                      {fmt(report.avgRpeDeviation)} RPE points
                    </strong>
                    .{' '}
                    {report.avgRpeDeviation > 0.5
                      ? 'The block was too heavy — consider starting ~2.5% lighter next time.'
                      : report.avgRpeDeviation < -0.5
                        ? 'The block was too light — athlete had more in reserve than planned.'
                        : 'Prescriptions were well-calibrated.'}
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b">
                        <th className="pb-2 pr-6 font-medium">Exercise</th>
                        <th className="pb-2 pr-6 font-medium">Week</th>
                        <th className="pb-2 pr-6 font-medium">Reported RPE</th>
                        {hasRpeDeviation && (
                          <th className="pb-2 pr-6 font-medium">Prescribed</th>
                        )}
                        {hasRpeDeviation && (
                          <th className="pb-2 font-medium">Delta</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {report.rpeDeviations.map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1.5 pr-6">{row.exerciseName}</td>
                          <td className="py-1.5 pr-6">Wk {row.weekIndex + 1}</td>
                          <td className="py-1.5 pr-6">{fmt(row.reportedRpe, 1)}</td>
                          {hasRpeDeviation && (
                            <td className="py-1.5 pr-6">
                              {row.prescribedRpe !== null ? fmt(row.prescribedRpe, 1) : '—'}
                            </td>
                          )}
                          {hasRpeDeviation && (
                            <td
                              className={`py-1.5 font-medium ${
                                row.delta !== null ? deviationLabel(row.delta) : ''
                              }`}
                            >
                              {row.delta !== null
                                ? `${row.delta > 0 ? '+' : ''}${fmt(row.delta)}`
                                : '—'}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
