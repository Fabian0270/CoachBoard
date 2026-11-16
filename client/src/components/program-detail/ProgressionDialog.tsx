import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import type { Workout } from '../../lib/programUtils'
import { planProgression, DELOAD, type PlannedChange, type ProgressionRule } from '../../lib/progression'

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Step one exercise week by week through the block: Load Cap, an RPE or %
 * target, reps, with deload weeks. Shows every change before applying it, and
 * the page offers Undo afterwards.
 */
export default function ProgressionDialog({
  open,
  onOpenChange,
  workouts,
  dates,
  exerciseNames,
  initialWeek,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workouts: Workout[]
  /** The program's calendar, 7 days a week. */
  dates: string[]
  exerciseNames: string[]
  initialWeek: number
  onApply: (changes: PlannedChange[], exercise: string) => Promise<boolean>
}) {
  const weeks = Math.floor(dates.length / 7)
  const [exercise, setExercise] = useState('')
  const [startWeek, setStartWeek] = useState(0)
  const [steps, setSteps] = useState({ load: '2.5', rpe: '0', pct: '0', reps: '0' })
  const [deloads, setDeloads] = useState<Set<number>>(new Set())
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!open) return
    setExercise((e) => (exerciseNames.includes(e) ? e : exerciseNames[0] ?? ''))
    setStartWeek(Math.min(initialWeek, Math.max(0, weeks - 2)))
    setDeloads(new Set())
  }, [open, exerciseNames, initialWeek, weeks])

  const num = (s: string) => {
    const n = Number(s.replace(',', '.'))
    return Number.isFinite(n) ? n : 0
  }
  const rule: ProgressionRule = {
    loadStep: num(steps.load), rpeStep: num(steps.rpe), pctStep: num(steps.pct), repsStep: Math.round(num(steps.reps)),
    deloadWeeks: [...deloads],
  }
  const plan = useMemo(
    () => (exercise ? planProgression(workouts, dates, exercise, startWeek, rule) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rule is rebuilt from these each render
    [workouts, dates, exercise, startWeek, steps, deloads],
  )
  const affectedWeeks = new Set(plan.map((c) => c.weekIndex)).size

  const field = (key: keyof typeof steps, label: string, hint: string) => (
    <div className="space-y-1">
      <Label htmlFor={`prog_${key}`}>{label}</Label>
      <input
        id={`prog_${key}`} inputMode="decimal" value={steps[key]}
        onChange={(e) => setSteps({ ...steps, [key]: e.target.value })}
        className="num h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )

  const describe = (v: PlannedChange['after']) =>
    [v.reps ? `${v.reps} reps` : '', v.weight != null ? `${v.weight} kg` : '', v.intensity ?? ''].filter(Boolean).join(' · ')

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!applying) onOpenChange(o) }}>
      <DialogContent className="flex max-h-[92vh] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>Progress an exercise</DialogTitle>
          <DialogDescription>
            Steps it week by week from the week you start from, wherever it already is on the same weekday.
            It does not add days — copy the week first if the later weeks are empty.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="prog_exercise">Exercise</Label>
            <select
              id="prog_exercise" value={exercise} onChange={(e) => setExercise(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {exerciseNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="prog_start">Starting from</Label>
            <select
              id="prog_start" value={startWeek} onChange={(e) => setStartWeek(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {Array.from({ length: Math.max(0, weeks - 1) }, (_, w) => <option key={w} value={w}>Week {w + 1} as it is</option>)}
            </select>
          </div>
          {field('load', 'Load Cap per week (kg)', 'e.g. 2.5, or −5')}
          {field('rpe', 'RPE per week', 'e.g. 0.5 — for "RPE 8", "@8"')}
          {field('pct', '% per week', 'e.g. 2.5 — for "75%"')}
          {field('reps', 'Reps per week', 'e.g. −1 — plain numbers only')}
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Deload weeks</legend>
          <p className="text-[11px] text-muted-foreground">
            The week before it, {Math.round((1 - DELOAD.loadFactor) * 100)}% lighter and {DELOAD.rpeOff} RPE
            ({DELOAD.pctOff}%) lower; the steps carry on after it.
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {Array.from({ length: weeks }, (_, w) => w).filter((w) => w > startWeek).map((w) => (
              <label key={w} className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="checkbox" className="h-4 w-4 accent-primary" checked={deloads.has(w)}
                  onChange={() => setDeloads((d) => { const n = new Set(d); if (n.has(w)) n.delete(w); else n.add(w); return n })}
                />
                Week {w + 1}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border" aria-live="polite">
          {plan.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              Nothing to change. The exercise needs to be in week {startWeek + 1} and in later weeks on the same weekday, with a
              value the steps apply to.
            </p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {plan.map((c) => (
                  <tr key={c.exerciseId} className="border-b last:border-0">
                    <td className="num whitespace-nowrap px-2 py-1 text-muted-foreground">
                      W{c.weekIndex + 1} {DAY[dates.indexOf(c.date) % 7]}{c.deload ? ' · deload' : ''}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground line-through">{describe(c.before)}</td>
                    <td className="px-2 py-1 font-medium">{describe(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={plan.length === 0 || applying}
            onClick={async () => {
              setApplying(true)
              try { if (await onApply(plan, exercise)) onOpenChange(false) } finally { setApplying(false) }
            }}
          >
            {applying ? 'Applying…' : `Apply to ${plan.length} row${plan.length === 1 ? '' : 's'}`}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applying}>Cancel</Button>
          <span className="ml-auto text-xs text-muted-foreground">{affectedWeeks} week{affectedWeeks === 1 ? '' : 's'} · can be undone</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
