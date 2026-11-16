import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useToast } from './ui/toast'
import { errorMessage, getList, sendJson } from '../lib/api'
import { nextMonday } from '../lib/dates'

const TEMPLATE = '__template__'

/**
 * Make a copy of a program: for another athlete, another start date, or as a
 * template with no athlete. Opened from the program page and from each
 * program's menu in the Programs list.
 */
export default function DuplicateProgramDialog({
  program,
  open,
  onOpenChange,
  defaultAthleteId,
}: {
  program: { id: string; name: string; athlete_id: string | null } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Who the copy is for, when known (starting a program from an athlete's page). */
  defaultAthleteId?: string
}) {
  const navigate = useNavigate()
  const toast = useToast()
  const [athletes, setAthletes] = useState<{ id: string; name: string }[]>([])
  const [form, setForm] = useState({ athlete: TEMPLATE, name: '', start: nextMonday(), keepResults: false, scaleLoads: true })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !program) return
    setForm({ athlete: defaultAthleteId ?? program.athlete_id ?? TEMPLATE, name: `${program.name} (copy)`, start: nextMonday(), keepResults: false, scaleLoads: true })
    getList<{ id: string; name: string }>('/api/athletes')
      .then(setAthletes)
      .catch((err) => toast.error(`Could not load your athletes. ${errorMessage(err)}`))
  }, [open, program, toast, defaultAthleteId])

  if (!program) return null
  const toAthlete = form.athlete === TEMPLATE ? null : form.athlete
  // Scaling needs someone to scale from and someone else to scale to.
  const canScale = !!toAthlete && !!program.athlete_id && toAthlete !== program.athlete_id

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await sendJson<{ id: string; scaled: number; notScaled: number }>('POST', `/api/programs/${program.id}/duplicate`, {
        athlete_id: toAthlete,
        name: form.name.trim(),
        start_date: form.start,
        keep_results: form.keepResults,
        scale_loads: canScale && form.scaleLoads,
      })
      const parts = [`Copied as "${form.name.trim()}".`]
      if (canScale && form.scaleLoads) {
        parts.push(`${res.scaled} load${res.scaled === 1 ? '' : 's'} scaled to the athlete's maxes.`)
        if (res.notScaled > 0) {
          parts.push(`${res.notScaled} kept as they were, for want of a max on one side — check those.`)
        }
      }
      toast.success(parts.join(' '))
      onOpenChange(false)
      navigate(`/programs/${res.id}`)
    } catch (err) {
      toast.error(`Could not copy the program. ${errorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate “{program.name}”</DialogTitle>
          <DialogDescription>
            Copies every day and exercise to a new program, starting on the Monday of the week you pick.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="dup_athlete">For</Label>
            <select
              id="dup_athlete"
              value={form.athlete}
              onChange={(e) => setForm({ ...form, athlete: e.target.value })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              <option value={TEMPLATE}>No athlete — keep it as a template</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="dup_name">Name</Label>
            <Input id="dup_name" required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dup_start">Start date</Label>
            <Input id="dup_start" type="date" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox" className="mt-0.5 h-4 w-4 accent-primary"
              checked={canScale && form.scaleLoads} disabled={!canScale}
              onChange={(e) => setForm({ ...form, scaleLoads: e.target.checked })}
            />
            <span>
              Scale loads to this athlete’s maxes
              <span className="block text-xs text-muted-foreground">
                {canScale
                  ? 'Load Cap on squat, bench and deadlift, by the ratio of the two athletes’ maxes, rounded to 2.5 kg.'
                  : 'Only when copying to a different athlete.'}
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox" className="mt-0.5 h-4 w-4 accent-primary"
              checked={form.keepResults}
              onChange={(e) => setForm({ ...form, keepResults: e.target.checked })}
            />
            <span>
              Keep what the athlete logged
              <span className="block text-xs text-muted-foreground">Load Used and Last Set RPE. Usually left out of a new block.</span>
            </span>
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !form.name.trim() || !form.start}>{saving ? 'Copying…' : 'Duplicate'}</Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
