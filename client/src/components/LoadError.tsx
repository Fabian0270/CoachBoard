import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from './ui/button'

/**
 * Shown when a screen could not load its data.
 *
 * Deliberately NOT an empty state. The distinction is the whole point: these
 * screens used to render "No athletes yet" or "All payments are up to date" when
 * a request failed, which tells a coach their data is gone or their invoices are
 * settled. Both are alarming, and both are false.
 *
 * The reassurance is not decoration either. In a local-first app the first
 * thought on seeing an empty screen is that the file is lost, so the panel says
 * plainly that nothing has been touched.
 */
export default function LoadError({
  what,
  message,
  onRetry,
  retrying,
}: {
  /** What failed to load, lowercase, e.g. "your athletes". */
  what: string
  message?: string
  onRetry: () => void
  retrying?: boolean
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-6 py-12 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500" />
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Could not load {what}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {message ?? 'Something went wrong.'} Nothing has been changed or lost — this is only a
          problem reading it just now.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RotateCw className={`h-4 w-4${retrying ? ' animate-spin' : ''}`} />
        {retrying ? 'Trying…' : 'Try again'}
      </Button>
    </div>
  )
}
