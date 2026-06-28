import type { Dispatch, SetStateAction } from 'react'
import { Button } from '../ui/button'
import { AlertTriangle, XCircle } from 'lucide-react'
import type { ExternalParseOverrides, SuggestionGoal } from 'coachboard-shared'
import { inputClass } from './helpers'
import type { Athlete, Entry } from './types'
import ColumnMapping from './ColumnMapping'
import ColumnMapper from './ColumnMapper'
import ExercisePreviewTable from './ExercisePreviewTable'

interface SingleImportFormProps {
  single: Entry
  athletes: Athlete[]
  athleteId: string
  setAthleteId: Dispatch<SetStateAction<string>>
  status: string
  setStatus: Dispatch<SetStateAction<string>>
  startDate: string
  setStartDate: Dispatch<SetStateAction<string>>
  saveStyle: boolean
  setSaveStyle: Dispatch<SetStateAction<boolean>>
  styleName: string
  setStyleName: Dispatch<SetStateAction<string>>
  reparsing: boolean
  remapOpen: boolean
  setRemapOpen: Dispatch<SetStateAction<boolean>>
  error: string | null
  canConfirm: boolean
  onOverride: (patch: Partial<ExternalParseOverrides>) => void
  onConfirm: () => void
  onReset: () => void
  setEntry: (key: string, patch: Partial<Entry>) => void
}

export default function SingleImportForm({
  single, athletes, athleteId, setAthleteId, status, setStatus, startDate, setStartDate,
  saveStyle, setSaveStyle, styleName, setStyleName, reparsing, remapOpen, setRemapOpen,
  error, canConfirm, onOverride, onConfirm, onReset, setEntry,
}: SingleImportFormProps) {
  const singlePreview = single.preview
  const singleHasErrors = !!single.error || (singlePreview?.errors.length ?? 0) > 0

  return (
    <div className="space-y-4">
      {singleHasErrors ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-1 text-destructive">
            <XCircle className="h-4 w-4" />
            This file can't be imported
          </h3>
          <ul className="text-sm text-muted-foreground space-y-0.5 list-disc list-inside">
            {single.error
              ? <li>{single.error}</li>
              : singlePreview!.errors.map((err, i) => <li key={i}>{err}</li>)}
          </ul>
          {/* Recovery: when the file parsed but couldn't be mapped, let the
              coach fix the columns live — fixing them clears the error. */}
          {singlePreview && (
            <ColumnMapper preview={singlePreview} reparsing={reparsing} onOverride={onOverride} />
          )}
          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={onReset}>Choose another file</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm">
            Detected <strong>{singlePreview!.weeks}</strong> week{singlePreview!.weeks !== 1 ? 's' : ''} ×{' '}
            <strong>{singlePreview!.days}</strong> day-block{singlePreview!.days !== 1 ? 's' : ''},{' '}
            <strong>{singlePreview!.exerciseCount}</strong> exercise{singlePreview!.exerciseCount !== 1 ? 's' : ''}.
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <ColumnMapping mapping={singlePreview!.columnMapping} />
              {singlePreview!.layout === 'vertical' && (
                <button
                  type="button"
                  onClick={() => setRemapOpen((o) => !o)}
                  className="text-xs text-muted-foreground underline shrink-0"
                >
                  {remapOpen ? 'Hide mapping' : 'Adjust…'}
                </button>
              )}
            </div>
            {remapOpen && singlePreview!.layout === 'vertical' && (
              <ColumnMapper preview={singlePreview!} reparsing={reparsing} onOverride={onOverride} />
            )}
          </div>

          {singlePreview!.warnings.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-semibold flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {singlePreview!.warnings.length} warning{singlePreview!.warnings.length !== 1 ? 's' : ''}
              </h3>
              <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                {singlePreview!.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
              </ul>
            </div>
          )}

          {singlePreview!.exercises.length > 0 && <ExercisePreviewTable preview={singlePreview!} />}

          <div className="space-y-3 border-t pt-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Athlete</label>
              <select className={inputClass} value={athleteId} onChange={(e) => setAthleteId(e.target.value)}>
                <option value="">Select an athlete…</option>
                {athletes.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{a.archived ? ' (archived)' : ''}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Program name</label>
              <input className={inputClass} value={single.programName} onChange={(e) => setEntry(single.key, { programName: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">Status</label>
                <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              {status === 'archived' ? (
                <div className="space-y-1">
                  <label className="text-sm font-medium">Start date</label>
                  <p className="text-xs text-muted-foreground pt-2">
                    Not needed for archived programs — days are placed in order automatically.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-sm font-medium">Start date</label>
                  <input type="date" className={inputClass} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Training focus</label>
              <select className={inputClass} value={single.focus} onChange={(e) => setEntry(single.key, { focus: e.target.value as SuggestionGoal | '' })}>
                <option value="">Unclassified</option>
                <option value="hypertrophy">Hypertrophy</option>
                <option value="strength">Strength</option>
                <option value="peaking">Peaking</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {singlePreview!.suggestedFocus
                  ? 'Pre-filled from the program’s rep ranges — helps tailor future suggestions.'
                  : 'Labels this program so suggestions can learn your style.'}
              </p>
            </div>

            {singlePreview!.layoutTemplate && (
              <div className="space-y-2 rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={saveStyle}
                    onChange={(e) => setSaveStyle(e.target.checked)}
                  />
                  Save this program’s style for future programs
                </label>
                <p className="text-xs text-muted-foreground">
                  Adds this sheet’s layout (colors, columns, day labels) to your style library so
                  you can apply it when creating new programs.
                </p>
                {saveStyle && (
                  <input
                    className={inputClass}
                    placeholder={`Style name (defaults to “${single.programName.trim() || 'Program'}”)`}
                    value={styleName}
                    onChange={(e) => setStyleName(e.target.value)}
                  />
                )}
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onReset}>Choose another file</Button>
            <Button onClick={onConfirm} disabled={!canConfirm}>Create program</Button>
          </div>
        </>
      )}
    </div>
  )
}
