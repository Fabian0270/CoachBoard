import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { useToast } from './ui/toast'
import { Download } from 'lucide-react'

interface UpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  version: string | null
}

/** Updates are rare; there is no reason to ask more often than this. */
const POLL_MS = 15 * 60 * 1000

/**
 * Shows a quiet prompt once a new version has already downloaded in the
 * background. Deliberately says nothing while checking, downloading or failing —
 * this app is offline-first, and "couldn't reach the update server" is not news
 * a coach needs.
 */
export default function UpdateNotice() {
  const toast = useToast()
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      try {
        const res = await fetch('/api/system/update')
        if (!res.ok) return
        const next = (await res.json()) as UpdateState
        if (!cancelled) setState(next)
      } catch {
        /* no updater on this platform, or the app is offline — stay silent */
      }
    }

    void check()
    const timer = window.setInterval(() => void check(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (dismissed || state?.status !== 'ready') return null

  const restart = async () => {
    try {
      const res = await fetch('/api/system/update/install', { method: 'POST' })
      if (!res.ok) throw new Error('install refused')
    } catch {
      toast.error('Could not restart automatically. Close and reopen CoachBoard to update.')
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-border bg-card p-4 shadow-lg">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-primary" />
        <p className="text-sm font-medium">Update ready</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {state.version ? `Version ${state.version} has` : 'A new version has'} been downloaded. It
        installs when you restart.
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={restart}>Restart now</Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>Later</Button>
      </div>
    </div>
  )
}
