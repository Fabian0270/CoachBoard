import { Button } from '../ui/button'
import { AlertTriangle, XCircle } from 'lucide-react'
import type { SuggestionGoal } from 'coachboard-shared'
import { inputClass, isImportable } from './helpers'
import type { Assignment, Athlete, Entry } from './types'

interface BulkImportReviewProps {
  entries: Entry[]
  groups: Array<{ key: string; label: string }>
  importableCount: number
  canBulkConfirm: boolean
  assignments: Record<string, Assignment>
  athletes: Athlete[]
  setAssignment: (groupKey: string, patch: Partial<Assignment>) => void
  setEntry: (key: string, patch: Partial<Entry>) => void
  onReset: () => void
  onConfirm: () => void
}

export default function BulkImportReview({
  entries, groups, importableCount, canBulkConfirm, assignments, athletes,
  setAssignment, setEntry, onReset, onConfirm,
}: BulkImportReviewProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Parsed <strong>{entries.length}</strong> file{entries.length !== 1 ? 's' : ''} ·{' '}
        <strong>{importableCount}</strong> ready to import · grouped into{' '}
        <strong>{groups.length}</strong> athlete{groups.length !== 1 ? 's' : ''}. Imported as archived.
      </p>

      <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
        {groups.map(({ key, label }) => {
          const groupEntries = entries.filter((e) => e.groupKey === key)
          const asg = assignments[key]
          return (
            <div key={key || '__unassigned'} className="rounded-lg border p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-xs text-muted-foreground">
                  {groupEntries.length} program{groupEntries.length !== 1 ? 's' : ''}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <select
                    className="rounded border bg-background px-2 py-1 text-xs"
                    value={asg?.mode === 'existing' ? `existing:${asg.existingId}` : 'new'}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === 'new') setAssignment(key, { mode: 'new' })
                      else setAssignment(key, { mode: 'existing', existingId: v.slice('existing:'.length) })
                    }}
                  >
                    <option value="new">Create new archived athlete</option>
                    {athletes.map((a) => (
                      <option key={a.id} value={`existing:${a.id}`}>
                        Assign to {a.name}{a.archived ? ' (archived)' : ''}
                      </option>
                    ))}
                  </select>
                  {asg?.mode === 'new' && (
                    <input
                      className="rounded border bg-background px-2 py-1 text-xs w-40"
                      placeholder="New athlete name"
                      value={asg.newName}
                      onChange={(e) => setAssignment(key, { newName: e.target.value })}
                    />
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                {groupEntries.map((e) => {
                  const importable = isImportable(e)
                  const warnings = e.preview?.warnings.length ?? 0
                  return (
                    <div key={e.key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={e.include && importable}
                        disabled={!importable}
                        onChange={(ev) => setEntry(e.key, { include: ev.target.checked })}
                        aria-label={`Include ${e.fileName}`}
                      />
                      <input
                        className={`${inputClass} flex-1 ${!importable ? 'opacity-50' : ''}`}
                        value={e.programName}
                        disabled={!importable}
                        onChange={(ev) => setEntry(e.key, { programName: ev.target.value })}
                      />
                      {importable ? (
                        <>
                          <select
                            className="rounded border bg-background px-1.5 py-1.5 text-xs"
                            value={e.focus}
                            onChange={(ev) => setEntry(e.key, { focus: ev.target.value as SuggestionGoal | '' })}
                          >
                            <option value="">Unclassified</option>
                            <option value="hypertrophy">Hypertrophy</option>
                            <option value="strength">Strength</option>
                            <option value="peaking">Peaking</option>
                          </select>
                          <span className="text-xs text-muted-foreground whitespace-nowrap w-28 text-right">
                            {e.preview!.weeks}w × {e.preview!.exerciseCount} ex
                          </span>
                          {warnings > 0 && (
                            <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap" title={e.preview!.warnings.map((w) => w.message).join('\n')}>
                              <AlertTriangle className="h-3 w-3" />{warnings}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-destructive flex items-center gap-1 whitespace-nowrap" title={e.error ?? e.preview?.errors.join('\n')}>
                          <XCircle className="h-3 w-3" />
                          {e.error ? 'Parse failed' : 'Can’t import'}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onReset}>Start over</Button>
        <Button onClick={onConfirm} disabled={!canBulkConfirm}>
          Import {importableCount} program{importableCount !== 1 ? 's' : ''}
        </Button>
      </div>
    </div>
  )
}
