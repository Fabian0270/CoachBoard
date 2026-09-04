import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LineChart, Trash2, UserPlus } from 'lucide-react'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import { isVbtLift, lastRepVelocity, liftLabel } from 'coachboard-shared/vbt'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'
import { useConfirm } from '../ui/confirm-dialog'

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

  const load = useCallback(() => {
    // withTrack=0: a path is up to 20 000 points and none of it is shown here.
    const scope = athleteId ? `athleteId=${encodeURIComponent(athleteId)}&` : ''
    fetch(`/api/analysis?${scope}withTrack=0`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: VideoAnalysisDto[]) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]))
  }, [athleteId])

  useEffect(load, [load, refreshKey])

  const remove = async (row: VideoAnalysisDto) => {
    const ok = await confirm({
      title: 'Delete this analysis?',
      description: 'The bar path and its numbers are removed. The video itself is untouched.',
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

  if (rows === null) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No saved analyses yet. Track a lift on the Bar path page and save it, and it appears here.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[38rem] text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1 pr-4 font-medium">Date</th>
            {!athleteId && <th className="py-1 pr-4 font-medium">Athlete</th>}
            <th className="py-1 pr-4 font-medium">Lift</th>
            <th className="py-1 pr-4 font-medium">Load</th>
            <th className="py-1 pr-4 font-medium">Reps</th>
            <th className="py-1 pr-4 font-medium">Last rep</th>
            <th className="py-1 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((row) => {
            const metrics = row.metrics ?? []
            // Propulsive where it exists, so the list agrees with the panel.
            const last = lastRepVelocity(metrics, 'propulsive') ?? lastRepVelocity(metrics)
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
                <td className="py-1">
                  <div className="flex items-center justify-end gap-1">
                    {/* Only a clip still in the library can be reopened — a local
                        file was never uploaded, so there is no video to return to. */}
                    {row.mediaId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Open this clip again"
                        onClick={() => navigate(`/analysis/${row.mediaId}`)}
                      >
                        <LineChart className="h-3.5 w-3.5" />
                      </Button>
                    )}
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
  )
}
