import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { FolderUp, Upload, Loader2, AlertTriangle, XCircle, Check } from 'lucide-react'
import { parseArchiveFilename } from '../lib/bulkImport'
import type { ExternalImportPreview, ExternalColumnMapping, SuggestionGoal } from 'coachboard-shared'

interface Athlete { id: string; name: string; archived: number }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (programId: string) => void   // single import → open the new program
  onImported: () => void                    // bulk import → refresh the list
}

type Step = 'pick' | 'parsing' | 'single' | 'bulk' | 'committing' | 'done'

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

// How a detected athlete-group maps onto a real athlete (bulk mode).
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

/** 1-based column index → spreadsheet letter (1 → A, 27 → AA). */
function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Local YYYY-MM-DD for an <input type="date"> default. */
function todayIso(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

// A file is importable if it parsed, has no fatal errors, and has exercises.
function isImportable(e: Entry): boolean {
  return !e.error && !!e.preview && e.preview.errors.length === 0 && e.preview.exerciseCount > 0
}

function ColumnMapping({ mapping }: { mapping: ExternalColumnMapping }) {
  const parts: string[] = []
  if (mapping.exercise) parts.push(`Exercise → ${colLetter(mapping.exercise)}`)
  if (mapping.sets) parts.push(`Sets → ${colLetter(mapping.sets)}`)
  if (mapping.reps) parts.push(`Reps → ${colLetter(mapping.reps)}`)
  if (mapping.load) parts.push(`Load → ${colLetter(mapping.load)}`)
  if (mapping.rpe) parts.push(`${mapping.rpeFromRir ? 'RIR' : 'RPE'} → ${colLetter(mapping.rpe)}`)
  return (
    <div className="text-sm">
      <span className="font-semibold">Detected columns: </span>
      <span className="text-muted-foreground">{parts.join(' · ')}</span>
      {mapping.rpeFromRir && <span className="text-muted-foreground"> (RIR converted to RPE)</span>}
    </div>
  )
}

function ExerciseTable({ preview }: { preview: ExternalImportPreview }) {
  return (
    <div className="overflow-x-auto rounded border max-h-[40vh]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted">
          <tr className="border-b">
            <th className="px-3 py-2 text-left font-medium">Week</th>
            <th className="px-3 py-2 text-left font-medium">Day</th>
            <th className="px-3 py-2 text-left font-medium">Exercise</th>
            <th className="px-3 py-2 text-center font-medium">Sets</th>
            <th className="px-3 py-2 text-center font-medium">Reps</th>
            <th className="px-3 py-2 text-center font-medium">Intensity</th>
            <th className="px-3 py-2 text-center font-medium">Load</th>
            <th className="px-3 py-2 text-center font-medium">RPE</th>
          </tr>
        </thead>
        <tbody>
          {preview.exercises.map((ex, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="px-3 py-1.5 text-muted-foreground">{ex.weekLabel}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{ex.dayLabel}</td>
              <td className="px-3 py-1.5 font-medium">{ex.name}</td>
              <td className="px-3 py-1.5 text-center">{ex.sets ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.reps ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.intensity ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.load ?? '—'}</td>
              <td className="px-3 py-1.5 text-center">{ex.rpe ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function ImportProgramsDialog({ open, onOpenChange, onCreated, onImported }: Props) {
  const folderRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('pick')
  const [entries, setEntries] = useState<Entry[]>([])
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [error, setError] = useState<string | null>(null)

  // bulk-mode state
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({})
  const [progress, setProgress] = useState(0)
  const [summary, setSummary] = useState<CommitSummary | null>(null)

  // single-mode finalize state
  const [athleteId, setAthleteId] = useState('')
  const [status, setStatus] = useState('active')
  const [startDate, setStartDate] = useState(todayIso())
  // opt-in: also save this file's layout into the reusable style library
  const [saveStyle, setSaveStyle] = useState(false)
  const [styleName, setStyleName] = useState('')

  useEffect(() => {
    if (!open) return
    // Include archived so they can be assigned an additional historical program.
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
    setAthleteId('')
    setStatus('active')
    setStartDate(todayIso())
    setSaveStyle(false)
    setStyleName('')
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
    // One file → the rich single-program finalize; many → the grouped batch flow.
    if (parsed.length === 1) {
      setStatus('active')
      setStartDate(todayIso())
      setStep('single')
    } else {
      setAssignments(buildAssignments(parsed, athletes))
      setStep('bulk')
    }
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

  // --- single-import commit -------------------------------------------------
  async function handleSingleConfirm() {
    const entry = entries[0]
    if (!entry || !isImportable(entry)) return
    setError(null)
    setStep('committing')
    try {
      const params = new URLSearchParams({ athlete_id: athleteId, name: entry.programName.trim(), status })
      if (status !== 'archived' && startDate) params.set('start_date', startDate)
      if (entry.focus) params.set('focus', entry.focus)
      if (saveStyle && entry.preview?.layoutTemplate) {
        params.set('save_style', '1')
        if (styleName.trim()) params.set('style_name', styleName.trim())
      }
      const buf = await entry.file.arrayBuffer()
      const res = await fetch(`/api/programs/import-external?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Import failed')
        setStep('single')
        return
      }
      onCreated(data.programId)
      handleClose(false)
    } catch {
      setError('Failed to reach server')
      setStep('single')
    }
  }

  // --- bulk-import commit ---------------------------------------------------
  async function handleBulkConfirm() {
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
      let groupAthleteId = ''
      try {
        if (asg.mode === 'existing') {
          groupAthleteId = asg.existingId
        } else {
          const res = await fetch('/api/athletes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: asg.newName.trim(), archived: true }),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? 'Failed to create athlete')
          groupAthleteId = data.id
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Athlete error'
        for (const e of list) failed.push({ name: e.programName, error: msg })
        continue
      }

      athleteIds.add(groupAthleteId)
      for (const e of list) {
        try {
          const buf = await e.file.arrayBuffer()
          // Bulk imports are historical → archived (no start date needed).
          const params = new URLSearchParams({ athlete_id: groupAthleteId, name: e.programName.trim(), status: 'archived' })
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

  // --- derived (bulk) -------------------------------------------------------
  const groups = entries.reduce<Array<{ key: string; label: string }>>((acc, e) => {
    if (!acc.some((g) => g.key === e.groupKey)) acc.push({ key: e.groupKey, label: e.groupLabel })
    return acc
  }, [])
  const importableCount = entries.filter(isImportable).length
  const canBulkConfirm = importableCount > 0 && groups.every(({ key }) => {
    const used = entries.some((e) => e.groupKey === key && e.include && isImportable(e))
    if (!used) return true
    const asg = assignments[key]
    if (!asg) return false
    return asg.mode === 'existing' ? asg.existingId !== '' : asg.newName.trim() !== ''
  })

  // --- derived (single) -----------------------------------------------------
  const single = entries.length === 1 ? entries[0] : null
  const singlePreview = single?.preview ?? null
  const singleHasErrors = !!single && (!!single.error || (singlePreview?.errors.length ?? 0) > 0)
  const canSingleConfirm =
    !!single && isImportable(single) && athleteId !== '' && single.programName.trim() !== '' &&
    (status === 'archived' || startDate !== '')

  const committingTotal = single ? 1 : entries.filter((e) => e.include && isImportable(e)).length

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import programs</DialogTitle>
        </DialogHeader>

        {/* Step: pick file(s) */}
        {(step === 'pick' || step === 'parsing') && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Import Excel programs built outside CoachBoard. Pick a <strong>single file</strong> to set its
              status and start date, or select <strong>several files / a whole folder</strong> to import a
              back-catalogue at once (stored as archived).
            </p>
            <p className="text-xs text-muted-foreground">
              For multi-file imports, name files <code>Athlete Name - Program.xlsx</code> to auto-group them by
              athlete. Files without a name are grouped under “Unassigned”.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => filesRef.current?.click()} disabled={step === 'parsing'}>
                {step === 'parsing'
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analysing…</>
                  : <><Upload className="h-4 w-4 mr-2" />Choose file(s)</>}
              </Button>
              <Button variant="outline" onClick={() => folderRef.current?.click()} disabled={step === 'parsing'}>
                <FolderUp className="h-4 w-4 mr-2" />Choose folder
              </Button>
              <span className="text-sm text-muted-foreground">.xlsx / .xls</span>
            </div>
            <input
              ref={filesRef}
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
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
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {/* Step: single-file preview + finalize */}
        {step === 'single' && single && (
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
                {singlePreview && <ColumnMapping mapping={singlePreview.columnMapping} />}
                <div className="flex justify-end pt-2">
                  <Button variant="outline" onClick={reset}>Choose another file</Button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm">
                  Detected <strong>{singlePreview!.weeks}</strong> week{singlePreview!.weeks !== 1 ? 's' : ''} ×{' '}
                  <strong>{singlePreview!.days}</strong> day-block{singlePreview!.days !== 1 ? 's' : ''},{' '}
                  <strong>{singlePreview!.exerciseCount}</strong> exercise{singlePreview!.exerciseCount !== 1 ? 's' : ''}.
                </p>
                <ColumnMapping mapping={singlePreview!.columnMapping} />

                {singlePreview!.warnings.length > 0 && (
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold flex items-center gap-1 text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {singlePreview!.warnings.length} warning{singlePreview!.warnings.length !== 1 ? 's' : ''}
                    </h3>
                    <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                      {singlePreview!.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
                    </ul>
                  </div>
                )}

                {singlePreview!.exercises.length > 0 && <ExerciseTable preview={singlePreview!} />}

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
                  <Button variant="outline" onClick={reset}>Choose another file</Button>
                  <Button onClick={handleSingleConfirm} disabled={!canSingleConfirm}>Create program</Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step: bulk review */}
        {step === 'bulk' && (
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
              <Button onClick={handleBulkConfirm} disabled={!canBulkConfirm}>
                Import {importableCount} program{importableCount !== 1 ? 's' : ''}
              </Button>
            </div>
          </div>
        )}

        {/* Step: committing */}
        {step === 'committing' && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {single ? 'Creating program…' : `Importing… ${progress} / ${committingTotal}`}
            </span>
          </div>
        )}

        {/* Step: done (bulk summary; single navigates away) */}
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
