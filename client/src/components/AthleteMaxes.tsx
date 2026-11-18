import { useEffect, useMemo, useState } from 'react'
import type { AthleteMax } from 'coachboard-shared'
import { RPE_VALUES, MIN_REPS, MAX_REPS, targetWeight } from 'coachboard-shared/rpe'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useToast } from './ui/toast'
import { useConfirm } from './ui/confirm-dialog'
import { Plus, Trash2 } from 'lucide-react'
import { localToday } from '../lib/dates'
import { ApiError, errorMessage, getList, sendJson } from '../lib/api'
import LoadError from './LoadError'
import { plateStep, unitOf, type LoadUnit } from 'coachboard-shared/units'

const SUGGESTED_LIFTS = ['Squat', 'Bench Press', 'Deadlift']

// Local, not UTC: a PR logged just after midnight belongs to the new day.
const today = localToday

function formatWeight(w: number): string {
  return Number.isInteger(w) ? String(w) : w.toFixed(1)
}

/**
 * `unit` is the athlete's (S3, D76): new PRs are logged in it. A max recorded in
 * another unit (kept when the coach switched without converting) still shows
 * and rounds in its own.
 */
export default function AthleteMaxes({ athleteId, unit = 'kg' }: { athleteId: string; unit?: LoadUnit }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [maxes, setMaxes] = useState<AthleteMax[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ lift_name: '', weight: '', recorded_at: today() })
  const [saving, setSaving] = useState(false)
  const [selectedLift, setSelectedLift] = useState<string | null>(null)

  // A failed load used to show "No PRs yet" — telling a coach the athlete's
  // maxes were gone.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    getList<AthleteMax>(`/api/athletes/${encodeURIComponent(athleteId)}/maxes`)
      .then((data) => { if (!cancelled) setMaxes(data) })
      .catch((err) => { if (!cancelled) setLoadError(errorMessage(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [athleteId, attempt])

  // Latest PR per lift — the API returns lift_name asc, recorded_at desc,
  // so the first row seen per lift is the current max.
  const currentMaxes = useMemo(() => {
    const m = new Map<string, AthleteMax>()
    for (const max of maxes) {
      if (!m.has(max.lift_name)) m.set(max.lift_name, max)
    }
    return [...m.values()]
  }, [maxes])

  const activeLift = selectedLift && currentMaxes.some((m) => m.lift_name === selectedLift)
    ? selectedLift
    : currentMaxes[0]?.lift_name ?? null
  const activeMax = currentMaxes.find((m) => m.lift_name === activeLift) ?? null

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch(`/api/athletes/${athleteId}/maxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lift_name: form.lift_name.trim(),
          weight: Number(form.weight),
          unit,
          recorded_at: form.recorded_at,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        toast.error(`Failed to save PR: ${err.error ?? JSON.stringify(err)}`)
        return
      }
      const created: AthleteMax = await res.json()
      setMaxes((list) => {
        const next = [...list, created]
        next.sort((a, b) => a.lift_name.localeCompare(b.lift_name) || b.recorded_at.localeCompare(a.recorded_at))
        return next
      })
      setSelectedLift(created.lift_name)
      setForm({ lift_name: '', weight: '', recorded_at: today() })
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (max: AthleteMax) => {
    if (!(await confirm({
      title: `Delete ${max.lift_name} ${formatWeight(max.weight)} ${max.unit} (${max.recorded_at})?`,
      confirmLabel: 'Delete',
      destructive: true,
    }))) return
    // A refused delete used to leave the row in place without a word.
    try {
      await sendJson('DELETE', `/api/athletes/${athleteId}/maxes/${max.id}`)
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        toast.error(`Could not delete that PR. ${errorMessage(err)}`)
        return
      }
    }
    setMaxes((list) => list.filter((m) => m.id !== max.id))
  }

  if (loading) return <div className="text-muted-foreground">Loading...</div>
  if (loadError) return <LoadError what="this athlete's maxes" message={loadError} onRetry={() => setAttempt((n) => n + 1)} />

  const reps = Array.from({ length: MAX_REPS - MIN_REPS + 1 }, (_, i) => MIN_REPS + i)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Log a PR</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <Label htmlFor="lift">Lift</Label>
              <Input
                id="lift"
                required
                list="lift-suggestions"
                placeholder="e.g. Squat"
                value={form.lift_name}
                onChange={(e) => setForm({ ...form, lift_name: e.target.value })}
              />
              <datalist id="lift-suggestions">
                {[...new Set([...SUGGESTED_LIFTS, ...currentMaxes.map((m) => m.lift_name)])].map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pr-weight">Weight ({unit})</Label>
              <Input
                id="pr-weight"
                required
                type="number"
                min="1"
                step="0.5"
                className="w-28"
                value={form.weight}
                onChange={(e) => setForm({ ...form, weight: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pr-date">Date</Label>
              <Input
                id="pr-date"
                type="date"
                value={form.recorded_at}
                onChange={(e) => setForm({ ...form, recorded_at: e.target.value })}
              />
            </div>
            <Button type="submit" disabled={saving}>
              <Plus className="h-4 w-4 mr-1" />{saving ? 'Saving...' : 'Add PR'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {currentMaxes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No PRs yet — log a squat, bench or deadlift max to get the RPE cheat sheet.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>RPE cheat sheet</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {currentMaxes.map((m) => (
                  <Button
                    key={m.lift_name}
                    type="button"
                    size="sm"
                    variant={m.lift_name === activeLift ? 'default' : 'outline'}
                    onClick={() => setSelectedLift(m.lift_name)}
                  >
                    {m.lift_name} · {formatWeight(m.weight)} {m.unit}{m.estimated ? ' (est.)' : ''}
                  </Button>
                ))}
              </div>
              {activeMax && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Weights for {activeMax.lift_name} based on a {formatWeight(activeMax.weight)} {activeMax.unit} max
                    (Tuchscherer RPE chart, rounded to {plateStep(unitOf(activeMax.unit))} {unitOf(activeMax.unit)}).
                  </p>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full min-w-[600px] border-collapse text-sm">
                      <thead>
                        <tr className="bg-muted/50 text-xs text-muted-foreground">
                          <th className="border-b border-r border-border px-2 py-1.5 text-left font-medium">Reps</th>
                          {RPE_VALUES.map((rpe) => (
                            <th key={rpe} className="border-b border-r border-border px-2 py-1.5 text-right font-medium">
                              RPE {rpe}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {reps.map((r) => (
                          <tr key={r} className="even:bg-muted/20">
                            <td className="border-b border-r border-border px-2 py-1 font-medium">{r}</td>
                            {RPE_VALUES.map((rpe) => {
                              const w = targetWeight(activeMax.weight, r, rpe, plateStep(unitOf(activeMax.unit)))
                              return (
                                <td key={rpe} className="border-b border-r border-border px-2 py-1 text-right tabular-nums">
                                  {w === null ? '—' : formatWeight(w)}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>PR history</CardTitle></CardHeader>
            <CardContent className="space-y-1">
              {maxes.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-accent/30">
                  <div>
                    <span className="font-medium">{m.lift_name}</span>
                    <span className="ml-2 text-primary font-semibold">{formatWeight(m.weight)} {m.unit}</span>
                    <span className="ml-2 text-sm text-muted-foreground">{m.recorded_at.slice(0, 10)}</span>
                    {/* From bar speed, confirmed by the coach (BP34, D60): not a lifted max. */}
                    {!!m.estimated && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Estimated from bar speed and confirmed by you — used for load hints, not counted as a PR">
                        estimated
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(m)}
                    aria-label={`Delete ${m.lift_name} PR`}
                    className="p-1.5 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
