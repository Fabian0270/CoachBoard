import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { useToast } from './ui/toast'
import { Download } from 'lucide-react'

type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

interface UpdateState {
  status: UpdateStatus
  version: string | null
}

/** Nothing in flight. Updates are rare, so there is no reason to ask often. */
const IDLE_POLL_MS = 15 * 60 * 1000

/**
 * Something is in flight, or is about to be.
 *
 * A single slow cadence made this notice close to decorative: the ~80 MB
 * download finishes somewhere inside a 15-minute gap, so a coach who opens the
 * app, works, and closes it never saw the prompt at all. The update still
 * installed on quit — autoInstallOnAppQuit — but silently, which is not what a
 * "restart to update" banner is for.
 */
const ACTIVE_POLL_MS = 10 * 1000

/**
 * How long after mount to keep asking quickly whatever the last answer said.
 *
 * Polling fast only while the status reads 'checking' or 'downloading' looks
 * sufficient and is not: initAutoUpdate() runs AFTER createWindow() in the
 * Electron main process, so this component routinely makes its first request
 * before the check has started and is told the default 'idle'. Dropping to the
 * slow cadence on that answer would miss the entire download — the exact bug
 * this change exists to fix.
 */
const WARMUP_MS = 3 * 60 * 1000

const isBusy = (status: UpdateStatus | undefined): boolean =>
  status === 'checking' || status === 'downloading'

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
    let timer = 0
    const mountedAt = Date.now()

    // A self-rescheduling timeout rather than an interval, because the gap has
    // to change with the answer.
    const check = async (): Promise<void> => {
      let next: UpdateState | null = null
      try {
        const res = await fetch('/api/system/update')
        if (res.ok) next = (await res.json()) as UpdateState
      } catch {
        /* no updater on this platform, or the app is offline — stay silent */
      }
      if (cancelled) return
      if (next) setState(next)

      // 'ready' is terminal: the banner is up and no later answer can change it.
      if (next?.status === 'ready') return

      const fast = isBusy(next?.status) || Date.now() - mountedAt < WARMUP_MS
      timer = window.setTimeout(() => void check(), fast ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    }

    void check()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
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
