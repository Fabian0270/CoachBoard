import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

interface Props {
  programId: string
  /** Bumping this re-fetches the preview (e.g. after the program changes). */
  refreshKey?: number
}

// Renders the server-built HTML preview of the program's .xlsx. The HTML is the
// exact workbook that Download/Email produces, converted to a styled table, so
// what the coach sees here is what the athlete receives.
export default function ExcelPreview({ programId, refreshKey }: Props) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/programs/${programId}/export/preview`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data.error ?? 'Failed to build the preview')
        return data.html as string
      })
      .then((h) => { if (!cancelled) setHtml(h) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [programId, refreshKey])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Building preview…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  return (
    <div className="overflow-auto rounded-md border bg-white p-3">
      <div dangerouslySetInnerHTML={{ __html: html ?? '' }} />
    </div>
  )
}
