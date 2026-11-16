import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LineChart, Trash2, UserPlus } from 'lucide-react'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import {
  defaultVelocityMetric,
  isVbtLift,
  isVelocityMetric,
  lastRepVelocity,
  liftLabel,
} from 'coachboard-shared/vbt'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'
import { useConfirm } from '../ui/confirm-dialog'
import LoadError from '../LoadError'
import { errorMessage, getList } from '../../lib/api'

// ---------------------------------------------------------------------------
// Saved bar-path analyses.
//
// Before this they were write-only: stored, silently feeding the velocity
// profile, and visible nowhere. A coach could not see what had been kept, reopen
// one, or delete a mistake.
//
// One component over one endpoint, used from two places — an athlete's own page,
// where you go when thinking about one lifter, and the bar path landing page,
// for picking up where you left off. `athleteId` is what separates the two.
// ---------------------------------------------------------------------------

interface Props {
  /** Scope to one athlete. Omit for everything, newest first. */
  athleteId?: string
  /** How many rows to show. */
  limit?: number
  /** Athletes to offer when attaching an orphan. Omit to hide that action. */
  athletes?: { id: string; name: string }[]
  /** Bumping this refetches — the bar path page uses it after a save. */
  refreshKey?: number
}

export default function SavedAnalyses({ athleteId, limit = 20, athletes, refreshKey }: Props) {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const [rows, setRows] = useState<VideoAnalysisDto[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The list stopped at `limit` with no way to see the rest (BP20).
  const [showAll, setShowAll] = useState(false)
  const [athleteFilter, setAthleteFilter] = useState('')
  const [liftFilter, setLiftFilter] = useState('')

  const load = useCallback(() => {
    // withTrack=0: a path is up to 20 000 points and none of it is shown here.
    const scope = athleteId ? `athleteId=${encodeURIComponent(athleteId)}&` : ''
    // A failure used to read as "No saved analyses yet".
    setLoadError(null)
    getList<VideoAnalysisDto>(`/api/analysis?${scope}withTrack=0`)
      .then(setRows)
      .catch((err) => setLoadError(errorMessage(err)))
  }, [athleteId])

  useEffect(load, [load, refreshKey])

  const remove = async (row: VideoAnalysisDto) => {
    const ok = await confirm({
      title: 'Delete this analysis?',
      description:
        'The bar path, its numbers and the kept copy of the video are all removed. A synced Discord clip stays in your library.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    const res = await fetch(`/api/analysis/${row.id}`, { method: 'DELETE' })
    if (res.ok) {
      setRows((r) => r?.filter((x) => x.id !== row.id) ?? null)
    } else {
      toast.error('Could not delete that analysis.')
    }
  }

  const attach = async (row: VideoAnalysisDto, nextAthleteId: string) => {
    const res = await fetch(`/api/analysis/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteId: nextAthleteId }),
    })
    if (!res.ok) {
      toast.error('Could not attach that analysis.')
      return
    }
    const updated = (await res.json()) as VideoAnalysisDto
    setRows((r) => r?.map((x) => (x.id === row.id ? updated : x)) ?? null)
    toast.success(`Attached to ${updated.athleteName ?? 'the athlete'}.`)
  }

  if (loadError) return <LoadError what="your saved analyses" message={loadError} onRetry={load} />
  if (rows === null) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No saved analyses yet. Track a lift on the Bar path page and save it, and it appears here.
      </p>
    )
  }

  // Filters offer only what is in the list.
  const athleteOptions = [...new Map(rows.filter((r) => r.athleteId).map((r) => [r.athleteId!, r.athleteName ?? 'Unnamed'])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
  const liftOptions = [...new Set(rows.map((r) => r.lift).filter(isVbtLift))]
  const filtered = rows.filter((r) =>
    (!athleteFilter || (athleteFilter === 'none' ? !r.athleteId : r.athleteId === athleteFilter)) &&
    (!liftFilter || r.lift === liftFilter))
  const shown = showAll ? filtered : filtered.slice(0, limit)
  const selectCls = 'rounded-md border bg-background px-2 py-1 text-xs'

  return (
    <div className="space-y-2">
      {(rows.length > limit || athleteOptions.length > 1 || liftOptions.length > 1) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {!athleteId && (
            <select aria-label="Filter by athlete" value={athleteFilter} onChange={(e) => setAthleteFilter(e.target.value)} className={selectCls}>
              <option value="">All athletes</option>
              {athleteOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              {rows.some((r) => !r.athleteId) && <option value="none">Unassigned</option>}
            </select>
          )}
          <select aria-label="Filter by lift" value={liftFilter} onChange={(e) => setLiftFilter(e.target.value)} className={selectCls}>
            <option value="">All lifts</option>
            {liftOptions.map((l) => <option key={l} value={l}>{liftLabel(l)}</option>)}
          </select>
          <span className="text-muted-foreground">
            {shown.length} of {filtered.length}{filtered.length !== rows.length ? ` (${rows.length} in all)` : ''}
          </span>
        </div>
      )}
    <div className="overflow-x-auto">
      <table className="w-full min-w-[38rem] text-sm" aria-label="Saved analyses">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1 pr-4 font-medium">Date</th>
            {!athleteId && <th className="py-1 pr-4 font-medium">Athlete</th>}
            <th className="py-1 pr-4 font-medium">Lift</th>
            <th className="py-1 pr-4 font-medium">Load</th>
            <th className="py-1 pr-4 font-medium">Reps</th>
            <th className="py-1 pr-4 font-medium">Last rep</th>
            <th className="py-1 pr-4 font-medium">Note</th>
            <th className="py-1 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr><td colSpan={8} className="py-3 text-muted-foreground">Nothing matches those filters.</td></tr>
          )}
          {shown.map((row) => {
            const metrics = row.metrics ?? []
            // Read with the metric the set was saved with, so this list, the
            // saved view and the live panel never show one set three ways.
            const rowLift = isVbtLift(row.lift) ? row.lift : 'back-squat'
            const last = lastRepVelocity(
              metrics,
              isVelocityMetric(row.metric) ? row.metric : defaultVelocityMetric(rowLift),
            )
            const lift = isVbtLift(row.lift) ? liftLabel(row.lift) : '—'
            return (
              <tr key={row.id} className="border-b last:border-0">
                <td className="py-1 pr-4">{row.createdAt.slice(0, 10)}</td>
                {!athleteId && (
                  <td className="py-1 pr-4">
                    {row.athleteName ?? (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </td>
                )}
                <td className="py-1 pr-4">{lift}</td>
                <td className="py-1 pr-4">{row.loadKg != null ? `${row.loadKg} kg` : '—'}</td>
                <td className="py-1 pr-4">{metrics.length || '—'}</td>
                <td className="py-1 pr-4">{last != null ? `${last.toFixed(2)} m/s` : '—'}</td>
                <td className="max-w-[16rem] truncate py-1 pr-4 text-muted-foreground" title={row.notes ?? undefined}>{row.notes ?? ''}</td>
                <td className="py-1">
                  <div className="flex items-center justify-end gap-1">
                    {/* Every row opens: the saved view rebuilds the path from
                        the stored track, so a local clip whose video was never
                        uploaded is just as readable as one still in the library. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Open this analysis"
                      onClick={() => navigate(`/analysis/saved/${row.id}`)}
                    >
                      <LineChart className="h-3.5 w-3.5" />
                    </Button>
                    {!row.athleteId && athletes && athletes.length > 0 && (
                      <label className="flex items-center gap-1" title="Attach to an athlete">
                        <UserPlus className="h-3.5 w-3.5 text-muted-foreground" />
                        <select
                          defaultValue=""
                          onChange={(e) => e.target.value && void attach(row, e.target.value)}
                          className="rounded-md border bg-background px-1.5 py-0.5 text-xs"
                        >
                          <option value="">Attach…</option>
                          {athletes.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Delete this analysis"
                      onClick={() => void remove(row)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
      {filtered.length > limit && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs font-medium text-muted-foreground hover:text-foreground">
          {showAll ? 'Show fewer' : `Show all ${filtered.length}`}
        </button>
      )}
    </div>
  )
}
