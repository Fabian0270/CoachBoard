import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { useToast } from './ui/toast'
import { errorMessage, getJson, sendJson } from '../lib/api'
import { LOAD_UNITS, plateStep, unitOf, type LoadUnit } from 'coachboard-shared/units'

// ---------------------------------------------------------------------------
// kg / lb on the athlete's page (S3, D77). Switching an athlete who already has
// numbers asks first: convert them (rounded to the new unit's plates), or only
// change the unit from now on. Free text is never converted.
// ---------------------------------------------------------------------------

interface Impact { loadCaps: number; loadsUsed: number; maxes: number; barPathSets: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export default function AthleteUnitSwitch<A extends { id: string; unit?: string }>({ athlete, onChanged }: { athlete: A; onChanged: (updated: A) => void }) {
  const toast = useToast()
  const current = unitOf(athlete.unit)
  const [asking, setAsking] = useState<{ to: LoadUnit; impact: Impact } | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = async (to: LoadUnit, convert: boolean) => {
    setBusy(true)
    try {
      const updated = await sendJson<A>('POST', `/api/athletes/${encodeURIComponent(athlete.id)}/unit`, { unit: to, convert })
      setAsking(null)
      onChanged(updated)
      toast.success(convert ? `Switched to ${to} and converted their loads.` : `Switched to ${to}.`)
    } catch (e) {
      toast.error(`Could not change the unit. ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const choose = async (to: LoadUnit) => {
    if (to === current || busy) return
    setBusy(true)
    let impact: Impact
    try {
      impact = await getJson<Impact>(`/api/athletes/${encodeURIComponent(athlete.id)}/unit-impact`)
    } catch (e) {
      setBusy(false)
      toast.error(`Could not check their loads. ${errorMessage(e)}`)
      return
    }
    setBusy(false)
    const any = impact.loadCaps + impact.loadsUsed + impact.maxes + impact.barPathSets > 0
    if (any) setAsking({ to, impact })
    else void apply(to, false)
  }

  const parts = asking
    ? [
        asking.impact.loadCaps && plural(asking.impact.loadCaps, 'Load Cap', 'Load Caps'),
        asking.impact.loadsUsed && plural(asking.impact.loadsUsed, 'Load Used', 'Loads Used'),
        asking.impact.maxes && plural(asking.impact.maxes, 'max', 'maxes'),
        asking.impact.barPathSets && plural(asking.impact.barPathSets, 'bar path set', 'bar path sets'),
      ].filter(Boolean) as string[]
    : []

  return (
    <>
      <div role="radiogroup" aria-label="Unit" className="inline-flex rounded-md border p-0.5 text-xs">
        {LOAD_UNITS.map((u) => (
          <button
            key={u}
            type="button"
            role="radio"
            aria-checked={current === u}
            disabled={busy}
            onClick={() => void choose(u)}
            title={current === u ? `Loads are in ${u}` : `Switch to ${u}`}
            className={`rounded px-2 py-0.5 font-medium ${current === u ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {u}
          </button>
        ))}
      </div>
      <Dialog open={!!asking} onOpenChange={(v) => { if (!v && !busy) setAsking(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Convert their loads to {asking?.to}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            They have {parts.join(', ')} in {current}. Converting changes each number to {asking?.to}, rounded to
            the nearest {asking ? plateStep(asking.to) : ''} {asking?.to}. Text such as “RPE 8 @100” or “BW+20” is left as written.
          </p>
          <p className="text-sm text-muted-foreground">
            Not converting keeps every number as it is and only reads it as {asking?.to} from now on.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAsking(null)} disabled={busy}>Cancel</Button>
            <Button variant="outline" size="sm" onClick={() => asking && void apply(asking.to, false)} disabled={busy}>Don’t convert</Button>
            <Button size="sm" onClick={() => asking && void apply(asking.to, true)} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Convert to {asking?.to}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
