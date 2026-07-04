import { useEffect, useState } from 'react'
import { Loader2, Check, AlertTriangle } from 'lucide-react'
import { cn } from '../lib/utils'

interface BuiltinTemplate {
  id: string
  name: string
  description: string
}

interface Props {
  value: string
  onChange: (id: string) => void
  /** When set, prepends an "inherit" card with an empty-string value (used by the
   *  Generate wizard so a draft can keep the source program's template). */
  inheritOption?: { label: string; description: string }
}

// A lazy-loaded sample-data HTML preview of one built-in template. The HTML is the
// real export pipeline run over a fixed synthetic program, so it shows exactly what
// the look produces.
function TemplatePreview({ id }: { id: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setError(null)
    fetch(`/api/export-templates/${id}/preview`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data.error ?? 'Failed to build the preview')
        return data.html as string
      })
      .then((h) => { if (!cancelled) setHtml(h) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [id])

  if (error) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {error}
      </div>
    )
  }
  if (html === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Building preview…
      </div>
    )
  }
  return (
    <div className="max-h-64 overflow-auto rounded-md border bg-white p-2">
      <div
        className="origin-top-left scale-[0.85] text-[10px] leading-tight"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

/**
 * Stacked, selectable previews of the built-in starter templates. Each shows a
 * sample-data render so the coach can see the look before choosing. Mirrors the
 * program HTML preview, keyed by template id.
 */
export default function TemplatePicker({ value, onChange, inheritOption }: Props) {
  const [templates, setTemplates] = useState<BuiltinTemplate[]>([])

  useEffect(() => {
    fetch('/api/export-templates')
      .then((r) => r.json())
      .then((data) => setTemplates(Array.isArray(data) ? data : []))
      .catch(() => setTemplates([]))
  }, [])

  return (
    <div className="space-y-3">
      {inheritOption && (
        <div
          role="radio"
          aria-checked={value === ''}
          tabIndex={0}
          onClick={() => onChange('')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange('') } }}
          className={cn(
            'cursor-pointer rounded-lg border p-3 transition-colors',
            value === '' ? 'border-primary ring-2 ring-primary/30 bg-accent/40' : 'hover:bg-accent',
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded-full border',
                value === '' ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
              )}
            >
              {value === '' && <Check className="h-3 w-3" />}
            </span>
            <span className="font-medium">{inheritOption.label}</span>
          </div>
          <div className="ml-6 mt-0.5 text-xs text-muted-foreground">{inheritOption.description}</div>
        </div>
      )}
      {templates.map((t) => {
        const selected = t.id === value
        return (
          <div
            key={t.id}
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(t.id) } }}
            className={cn(
              'cursor-pointer rounded-lg border p-3 transition-colors',
              selected ? 'border-primary ring-2 ring-primary/30 bg-accent/40' : 'hover:bg-accent',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full border',
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
                )}
              >
                {selected && <Check className="h-3 w-3" />}
              </span>
              <span className="font-medium">{t.name}</span>
            </div>
            <div className="ml-6 mt-0.5 text-xs text-muted-foreground">{t.description}</div>
            <div className="ml-6 mt-2">
              <TemplatePreview id={t.id} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
