import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { useToast } from './ui/toast'
import LoadError from './LoadError'
import { errorMessage, getJson, sendJson } from '../lib/api'

// Whether the day editor suggests loads from the athlete's maxes. On by default;
// a coach who writes every load themselves can switch the suggestions off.

export default function DayEditorSettingsCard() {
  const toast = useToast()
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    getJson<{ loadHints: boolean }>('/api/settings/preferences')
      .then((p) => { setOn(p.loadHints); setError(null) })
      .catch((e) => setError(errorMessage(e)))
  }, [attempt])

  const toggle = async (next: boolean) => {
    setOn(next)
    try {
      await sendJson('PUT', '/api/settings/preferences', { loadHints: next })
      toast.success(next ? 'The day editor suggests loads again.' : 'The day editor no longer suggests loads.')
    } catch (e) {
      setOn(!next)
      toast.error(`Could not save that. ${errorMessage(e)}`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Day editor</CardTitle>
        <CardDescription>What the day editor fills in for you while you write a program.</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <LoadError what="the day editor setting" message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : on === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={on} onChange={(e) => void toggle(e.target.checked)} />
            <span>
              Suggest loads
              <span className="block text-xs text-muted-foreground">
                An empty Load Cap shows a suggested load: from the athlete’s max and the row’s RPE or %, or from
                the set above for a back-off such as “-10%”. “Use” or Ctrl+L fills it in; nothing is written
                unless you take it. Off, the cell stays empty until you type a load.
              </span>
            </span>
          </label>
        )}
      </CardContent>
    </Card>
  )
}
