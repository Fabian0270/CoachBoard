import { useEffect, useState } from 'react'
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
import { ArrowLeft, TrendingUp, CheckCircle2, Sparkles } from 'lucide-react'
import type { ProgramReport } from 'coachboard-shared'
import type { Program } from '../lib/programUtils'
import { SuggestProgramDialog } from '../components/SuggestProgramDialog'

const LIFT_COLORS: Record<string, string> = {
  squat: '#6366f1',
  bench: '#10b981',
  deadlift: '#f59e0b',
}

function fmt(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

function deviationLabel(delta: number): string {
  if (delta > 0.4) return 'text-red-500 dark:text-red-400'
  if (delta < -0.4) return 'text-blue-500 dark:text-blue-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

export default function ProgramReport() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [report, setReport] = useState<ProgramReport | null>(null)
  const [program, setProgram] = useState<Program | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatingMax, setUpdatingMax] = useState<Set<string>>(new Set())
  const [updatedMax, setUpdatedMax] = useState<Set<string>>(new Set())
  const [suggestOpen, setSuggestOpen] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      fetch(`/api/programs/${id}/report`).then((r) => r.json()),
      fetch(`/api/programs/${id}`).then((r) => r.json()),
    ])
      .then(([rep, prog]) => {
        setReport(rep)
        setProgram(prog)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [id])

  const handleUpdateMax = async (liftKey: string, displayName: string, e1rm: number) => {
    if (!report) return
    setUpdatingMax((prev) => new Set([...prev, liftKey]))
    try {
      const res = await fetch(`/api/athletes/${report.athleteId}/maxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lift_name: displayName,
          weight: e1rm,
          unit: 'kg',
          recorded_at: new Date().toISOString().slice(0, 10),
          notes: 'Estimated 1RM from program analysis',
        }),
      })
      if (res.ok) setUpdatedMax((prev) => new Set([...prev, liftKey]))
    } finally {
      setUpdatingMax((prev) => {
        const s = new Set(prev)
        s.delete(liftKey)
        return s
      })
    }
  }

  if (loading) return <div className="text-muted-foreground">Loading report...</div>
  if (error) return <div className="text-destructive">Failed to load report: {error}</div>
  if (!report || !program) return <div className="text-muted-foreground">Report not found.</div>

  const hasData = report.exercisesCompleted > 0
  const completionPct = Math.round(report.completionRate * 100)
  const hasRpeDeviation = report.rpeDeviations.some((r) => r.delta !== null)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to={`/programs/${id}`}>
          <ArrowLeft className="h-5 w-5 text-muted-foreground" />
        </Link>
        <div>
          <p className="text-sm text-muted-foreground leading-none">{program.name}</p>
          <h1 className="text-3xl font-bold">Program Report</h1>
        </div>
        <Badge variant={program.status === 'completed' ? 'secondary' : 'default'}>
          {program.status}
        </Badge>
        {program.focus && (
          <Badge variant="outline" className="capitalize">{program.focus}</Badge>
        )}
        {(program.status === 'completed' || program.status === 'archived') && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setSuggestOpen(true)}
          >
            <Sparkles className="h-4 w-4 mr-1.5" />
            Generate next program
          </Button>
        )}
      </div>

      {id && report && (
        <SuggestProgramDialog
          open={suggestOpen}
          onOpenChange={setSuggestOpen}
          programId={id}
          athleteId={report.athleteId}
          onCreated={(draftId) => navigate(`/programs/${draftId}`)}
        />
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                      <Badge variant="outline">Best {fmt(trend.bestE1RM)} kg</Badge>
                      <Badge variant="outline">Latest {fmt(trend.latestE1RM)} kg</Badge>
                    </div>
                    {trend.dataPoints.length > 1 ? (
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart
                          data={trend.dataPoints}
                          margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="hsl(var(--border))"
                          />
                          <XAxis
                            dataKey="weekIndex"
                            tickFormatter={(w: number) => `Wk ${w + 1}`}
                            tick={{ fontSize: 12 }}
                          />
                          <YAxis
                            domain={['auto', 'auto']}
                            tickFormatter={(v: number) => `${v}`}
                            tick={{ fontSize: 12 }}
                            width={48}
                            unit=" kg"
                          />
                          <Tooltip
                            formatter={(value: number) => [`${value} kg`, 'e1RM']}
                            labelFormatter={(label: number) => `Week ${label + 1}`}
                          />
                          <Line
                            type="monotone"
                            dataKey="e1rm"
                            stroke={LIFT_COLORS[trend.liftKey] ?? '#888'}
                            strokeWidth={2}
                            dot={{ r: 4 }}
                            activeDot={{ r: 6 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Only one data point — {fmt(trend.dataPoints[0]?.e1rm)} kg
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
                              ? `Stored max: ${storedMax.weight} ${storedMax.unit}  →  e1RM this block: ${fmt(trend.latestE1RM)} kg`
                              : `No stored max  →  e1RM this block: ${fmt(trend.latestE1RM)} kg`}
                          </div>
                        </div>
                        {alreadyUpdated ? (
                          <div className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
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
                            {isUpdating ? 'Saving…' : `Set PR to ${fmt(trend.latestE1RM)} kg`}
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
