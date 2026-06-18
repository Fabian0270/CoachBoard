import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { FolderUp, Upload, Loader2, AlertTriangle, XCircle, Check } from 'lucide-react'
import { parseArchiveFilename } from '../lib/bulkImport'
import type { ExternalImportPreview, SuggestionGoal } from 'coachboard-shared'

interface Athlete { id: string; name: string; archived: number }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}

type Step = 'pick' | 'parsing' | 'review' | 'committing' | 'done'

// One uploaded file, after its dry-run parse.
interface Entry {
  key: string
  file: File
  fileName: string
  groupKey: string          // lowercased athlete name, '' = unassigned
  groupLabel: string        // display name for the group
  programName: string       // editable
  focus: SuggestionGoal | ''
  include: boolean
  preview: ExternalImportPreview | null
  error: string | null      // parse/network error
}

// How a detected athlete-group maps onto a real athlete.
interface Assignment {
  mode: 'new' | 'existing'
  existingId: string
  newName: string
}

interface CommitSummary {
  imported: number
  athletes: number
  skipped: number
  failed: Array<{ name: string; error: string }>
}

const inputClass = 'w-full rounded border bg-background px-2 py-1.5 text-sm'

// A file is importable if it parsed, has no fatal errors, and has exercises.
function isImportable(e: Entry): boolean {
  return !e.error && !!e.preview && e.preview.errors.length === 0 && e.preview.exerciseCount > 0
}

export default function BulkImportDialog({ open, onOpenChange, onImported }: Props) {
  const folderRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('pick')
  const [entries, setEntries] = useState<Entry[]>([])
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({})
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [progress, setProgress] = useState(0)
  const [summary, setSummary] = useState<CommitSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    // Include archived so a coach can add another historical program to an
    // athlete they created in an earlier bulk run.
    fetch('/api/athletes?include_archived=1')
      .then((r) => r.json())
      .then((data) => setAthletes(Array.isArray(data) ? data : []))
      .catch(() => setAthletes([]))
  }, [open])

  function reset() {
    setStep('pick')
    setEntries([])
    setAssignments({})
    setProgress(0)
    setSummary(null)
    setError(null)
    if (folderRef.current) folderRef.current.value = ''
    if (filesRef.current) filesRef.current.value = ''
  }

  function handleClose(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const files = Array.from(fileList).filter((f) => /\.(xlsx|xls)$/i.test(f.name))
    if (files.length === 0) {
      setError('No .xlsx/.xls files found in that selection.')
      return
    }
    setError(null)
    setStep('parsing')

    const parsed: Entry[] = []
    for (const file of files) {
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      const { athleteName, programName } = parseArchiveFilename(path)
      const base: Omit<Entry, 'preview' | 'error'> = {
        key: `${path}:${file.size}:${file.lastModified}`,
        file,
        fileName: file.name,
        groupKey: athleteName.trim().toLowerCase(),
        groupLabel: athleteName.trim() || 'Unassigned',
        programName,
        focus: '',
        include: true,
      }
      try {
        const buf = await file.arrayBuffer()
        const res = await fetch('/api/programs/import-external?dry_run=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        })
        const data = await res.json()
        if (!res.ok) {
          parsed.push({ ...base, preview: null, error: data.error ?? 'Preview failed', include: false })
        } else {
          const pv = data as ExternalImportPreview
          const ok = pv.errors.length === 0 && pv.exerciseCount > 0
          parsed.push({ ...base, preview: pv, error: null, focus: pv.suggestedFocus ?? '', include: ok })
        }
      } catch {
        parsed.push({ ...base, preview: null, error: 'Failed to reach server', include: false })
      }
    }

    setEntries(parsed)
    setAssignments(buildAssignments(parsed, athletes))
    setStep('review')
  }

  // Seed each group's assignment: reuse an existing athlete whose name matches,
  // otherwise propose creating a new archived athlete with the detected name.
  function buildAssignments(parsed: Entry[], roster: Athlete[]): Record<string, Assignment> {
    const next: Record<string, Assignment> = {}
    for (const e of parsed) {
      if (next[e.groupKey]) continue
      const match = e.groupLabel !== 'Unassigned'
        ? roster.find((a) => a.name.trim().toLowerCase() === e.groupKey)
        : undefined
      next[e.groupKey] = match
        ? { mode: 'existing', existingId: match.id, newName: e.groupLabel }
        : { mode: 'new', existingId: '', newName: e.groupLabel === 'Unassigned' ? '' : e.groupLabel }
    }
    return next
  }

  function setEntry(key: string, patch: Partial<Entry>) {
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)))
  }

  function setAssignment(groupKey: string, patch: Partial<Assignment>) {
    setAssignments((a) => ({ ...a, [groupKey]: { ...a[groupKey], ...patch } }))
  }

  // Distinct group keys in first-seen order, each with its display label.
  const groups = entries.reduce<Array<{ key: string; label: string }>>((acc, e) => {
    if (!acc.some((g) => g.key === e.groupKey)) acc.push({ key: e.groupKey, label: e.groupLabel })
    return acc
  }, [])

  const importableCount = entries.filter(isImportable).length

  // Every group that still has importable, included files needs a resolvable target.
  const canConfirm = importableCount > 0 && groups.every(({ key }) => {
    const used = entries.some((e) => e.groupKey === key && e.include && isImportable(e))
    if (!used) return true
    const asg = assignments[key]
    if (!asg) return false
    return asg.mode === 'existing' ? asg.existingId !== '' : asg.newName.trim() !== ''
  })

  async function handleConfirm() {
    setStep('committing')
    setProgress(0)

    const importable = entries.filter((e) => e.include && isImportable(e))
    const byGroup = new Map<string, Entry[]>()
    for (const e of importable) {
      const list = byGroup.get(e.groupKey) ?? []
      list.push(e)
      byGroup.set(e.groupKey, list)
    }

    const failed: CommitSummary['failed'] = []
    const athleteIds = new Set<string>()
    let imported = 0

    for (const [groupKey, list] of byGroup) {
      const asg = assignments[groupKey]
      let athleteId = ''
      try {
        if (asg.mode === 'existing') {
          athleteId = asg.existingId
        } else {
          const res = await fetch('/api/athletes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: asg.newName.trim(), archived: true }),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? 'Failed to create athlete')
          athleteId = data.id
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Athlete error'
        for (const e of list) failed.push({ name: e.programName, error: msg })
        continue
      }

      athleteIds.add(athleteId)
      for (const e of list) {
        try {
          const buf = await e.file.arrayBuffer()
          // Bulk imports are historical → archived (no start date needed).
          const params = new URLSearchParams({ athlete_id: athleteId, name: e.programName.trim(), status: 'archived' })
          if (e.focus) params.set('focus', e.focus)
          const res = await fetch(`/api/programs/import-external?${params.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf,
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? 'Import failed')
          imported++
        } catch (err) {
          failed.push({ name: e.programName, error: err instanceof Error ? err.message : 'Import failed' })
        } finally {
          setProgress((p) => p + 1)
        }
      }
    }

    setSummary({ imported, athletes: athleteIds.size, skipped: entries.length - importable.length, failed })
    setStep('done')
    onImported()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import program archive</DialogTitle>
        </DialogHeader>

        {(step === 'pick' || step === 'parsing') && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Import a back-catalogue of Excel programs at once. Pick a folder (or several files) and
              we'll parse each one, group them by the athlete name in the filename, and let you assign
              owners before saving. Imported programs are stored as <strong>archived</strong>.
            </p>
            <p className="text-xs text-muted-foreground">
              Filename convention: <code>Athlete Name - Program.xlsx</code>. Files without a name are
              grouped under “Unassigned” for you to assign.
            </p>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={() => folderRef.current?.click()} disabled={step === 'parsing'}>
                {step === 'parsing'
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analysing…</>
                  : <><FolderUp className="h-4 w-4 mr-2" />Choose folder</>}
              </Button>
              <Button variant="outline" onClick={() => filesRef.current?.click()} disabled={step === 'parsing'}>
                <Upload className="h-4 w-4 mr-2" />Choose files
              </Button>
              <span className="text-sm text-muted-foreground">.xlsx / .xls</span>
            </div>
            {/* webkitdirectory is non-standard but supported in Chromium/Electron. */}
            <input
              ref={folderRef}
              type="file"
              // @ts-expect-error — webkitdirectory is not in the React DOM types
              webkitdirectory=""
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <input
              ref={filesRef}
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-4">
            <p className="text-sm">
              Parsed <strong>{entries.length}</strong> file{entries.length !== 1 ? 's' : ''} ·{' '}
              <strong>{importableCount}</strong> ready to import · grouped into{' '}
              <strong>{groups.length}</strong> athlete{groups.length !== 1 ? 's' : ''}.
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
                                  <span className="text-xs text-amber-600 flex items-center gap-0.5 whitespace-nowrap" title={e.preview!.warnings.map((w) => w.message).join('\n')}>
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
              <Button variant="outline" onClick={reset}>Start over</Button>
              <Button onClick={handleConfirm} disabled={!canConfirm}>
                Import {importableCount} program{importableCount !== 1 ? 's' : ''}
              </Button>
            </div>
          </div>
        )}

        {step === 'committing' && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Importing… {progress} / {entries.filter((e) => e.include && isImportable(e)).length}
            </span>
          </div>
        )}

        {step === 'done' && summary && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-green-600">
              <Check className="h-5 w-5" />
              <span className="text-sm font-medium">
                Imported {summary.imported} program{summary.imported !== 1 ? 's' : ''} into {summary.athletes} athlete{summary.athletes !== 1 ? 's' : ''}.
              </span>
            </div>
            {summary.skipped > 0 && (
              <p className="text-sm text-muted-foreground">{summary.skipped} file{summary.skipped !== 1 ? 's' : ''} skipped.</p>
            )}
            {summary.failed.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-sm font-semibold flex items-center gap-1 text-destructive">
                  <XCircle className="h-4 w-4" />
                  {summary.failed.length} failed
                </h3>
                <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                  {summary.failed.map((f, i) => <li key={i}>{f.name}: {f.error}</li>)}
                </ul>
              </div>
            )}
            <div className="flex justify-end pt-1">
              <Button onClick={() => handleClose(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
