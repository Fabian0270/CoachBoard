import { Loader2 } from 'lucide-react'
import type { ExternalImportPreview, ExternalParseOverrides } from 'coachboard-shared'
import { colLetter, inputClass, MAP_FIELDS } from './helpers'

// Editable column/header mapping — the recovery path when auto-detection is wrong.
// Driven by the server's effective mapping (preview.columnMapping); each change
// calls onOverride, which re-parses with the accumulated overrides.
export default function ColumnMapper({ preview, reparsing, onOverride }: {
  preview: ExternalImportPreview
  reparsing: boolean
  onOverride: (patch: Partial<ExternalParseOverrides>) => void
}) {
  const cols = Array.from({ length: Math.max(preview.columnCount, 1) }, (_, i) => i + 1)
  const colLabel = (i: number) => {
    const h = preview.headerCells[i - 1]?.trim()
    return h ? `${colLetter(i)} — ${h}` : `Column ${colLetter(i)}`
  }
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Column mapping</span>
        {reparsing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="text-xs text-muted-foreground">
        Wrong? Point each field at the right column. Exercise, Sets and Reps are required.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <label className="w-28 shrink-0 text-muted-foreground">Header row</label>
        <input
          type="number"
          min={1}
          className={`${inputClass} w-24`}
          value={preview.headerRowIndex || 1}
          onChange={(e) => { const n = parseInt(e.target.value, 10); if (n > 0) onOverride({ headerRow: n }) }}
        />
      </div>
      {MAP_FIELDS.map(({ key, label, required }) => (
        <div key={key} className="flex items-center gap-2 text-sm">
          <label className="w-28 shrink-0 text-muted-foreground">{label}{required && ' *'}</label>
          <select
            className={`${inputClass} flex-1`}
            value={preview.columnMapping[key] ?? ''}
            onChange={(e) => onOverride({ [key]: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
          >
            <option value="">— none —</option>
            {cols.map((i) => <option key={i} value={i}>{colLabel(i)}</option>)}
          </select>
        </div>
      ))}
      <label className="flex items-center gap-2 text-xs text-muted-foreground pt-0.5">
        <input
          type="checkbox"
          checked={preview.columnMapping.rpeFromRir}
          onChange={(e) => onOverride({ rpeFromRir: e.target.checked })}
        />
        That column holds RIR (reps in reserve), not RPE — convert it
      </label>
    </div>
  )
}
