import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { useToast } from './ui/toast'
import LoadError from './LoadError'
import { errorMessage, getJson, sendJson } from '../lib/api'
import { LOAD_UNITS, type LoadUnit } from 'coachboard-shared/units'

// The unit new athletes start with (S3, D78). Each athlete's own unit is on
// their profile; this only sets the starting point.

export default function UnitSettingsCard() {
  const toast = useToast()
  const [unit, setUnit] = useState<LoadUnit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    getJson<{ defaultUnit: LoadUnit }>('/api/settings/units')
      .then((r) => { setUnit(r.defaultUnit); setError(null) })
      .catch((e) => setError(errorMessage(e)))
  }, [attempt])

  const choose = async (next: LoadUnit) => {
    const before = unit
    setUnit(next)
    try {
      await sendJson('PUT', '/api/settings/units', { defaultUnit: next })
      toast.success(`New athletes start in ${next}.`)
    } catch (e) {
      setUnit(before)
      toast.error(`Could not save the unit. ${errorMessage(e)}`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Units</CardTitle>
        <CardDescription>
          The unit a new athlete starts in. Each athlete can be switched between kg and lb on their own
          page; their programs, maxes, reports, exported sheets and bar path sets then use it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <LoadError what="the unit setting" message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : unit === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div role="radiogroup" aria-label="Default unit for new athletes" className="flex gap-2">
            {LOAD_UNITS.map((u) => (
              <label key={u} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${unit === u ? 'border-primary bg-primary/10' : ''}`}>
                <input type="radio" name="default-unit" className="accent-primary" checked={unit === u} onChange={() => void choose(u)} />
                {u === 'kg' ? 'Kilograms (kg)' : 'Pounds (lb)'}
              </label>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
