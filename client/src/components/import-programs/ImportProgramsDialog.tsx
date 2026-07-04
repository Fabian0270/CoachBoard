import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { FolderUp, Upload, Loader2, XCircle, Check } from 'lucide-react'
import { parseArchiveFilename } from '../../lib/bulkImport'
import type { ExternalImportPreview, ExternalParseOverrides } from 'coachboard-shared'
import type { Athlete, Assignment, CommitSummary, Entry, Props, Step } from './types'
import { isImportable, overrideParams, todayIso } from './helpers'
import SingleImportForm from './SingleImportForm'
import BulkImportReview from './BulkImportReview'

export default function ImportProgramsDialog({ open, onOpenChange, onCreated, onImported, defaultAthleteId }: Props) {
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
  const [athleteId, setAthleteId] = useState(defaultAthleteId ?? '')
  const [status, setStatus] = useState('active')
  // single-mode manual column/header overrides (the remap recovery path)
  const [overrides, setOverrides] = useState<ExternalParseOverrides>({})
  const [reparsing, setReparsing] = useState(false)
  const [remapOpen, setRemapOpen] = useState(false)
  const [startDate, setStartDate] = useState(todayIso())
  // opt-in: also save this file's layout into the reusable style library
  const [saveStyle, setSaveStyle] = useState(false)
  const [styleName, setStyleName] = useState('')

  useEffect(() => {
    if (!open) return
    setAthleteId(defaultAthleteId ?? '')
    // Include archived so they can be assigned an additional historical program.
    fetch('/api/athletes?include_archived=1')
      .then((r) => r.json())
      .then((data) => setAthletes(Array.isArray(data) ? data : []))
      .catch(() => setAthletes([]))
  }, [open, defaultAthleteId])

  function reset() {
    setStep('pick')
    setEntries([])
    setAssignments({})
    setProgress(0)
    setSummary(null)
    setError(null)
    setAthleteId(defaultAthleteId ?? '')
    setStatus('active')
    setStartDate(todayIso())
    setOverrides({})
    setReparsing(false)
    setRemapOpen(false)
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

  // Re-parse the single file with the coach's accumulated manual overrides and
  // swap in the fresh preview (which carries the corrected mapping + data).
  async function applyOverride(patch: Partial<ExternalParseOverrides>) {
    const entry = entries[0]
    if (!entry) return
    const next = { ...overrides, ...patch }
    setOverrides(next)
    setReparsing(true)
    try {
      const params = overrideParams(next)
      params.set('dry_run', '1')
      const buf = await entry.file.arrayBuffer()
      const res = await fetch(`/api/programs/import-external?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      })
      const data = await res.json()
      if (res.ok) {
        const pv = data as ExternalImportPreview
        setEntry(entry.key, { preview: pv, error: null, focus: entry.focus || (pv.suggestedFocus ?? '') })
      } else {
        setEntry(entry.key, { preview: null, error: data.error ?? 'Preview failed' })
      }
    } catch {
      setEntry(entry.key, { error: 'Failed to reach server' })
    } finally {
      setReparsing(false)
    }
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
      // Commit with the same manual overrides used in the preview, so the stored
      // program (and its captured style) matches exactly what the coach reviewed.
      for (const [k, v] of overrideParams(overrides)) params.set(k, v)
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
    // Save the batch's style once — from the first file that carries a layout
    // (a batch from one template shares one style; avoids duplicate entries).
    let styleSaved = false

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
          if (saveStyle && !styleSaved && e.preview?.layoutTemplate) {
            params.set('save_style', '1')
            if (styleName.trim()) params.set('style_name', styleName.trim())
            styleSaved = true
          }
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
          <SingleImportForm
            single={single}
            athletes={athletes}
            athleteId={athleteId}
            setAthleteId={setAthleteId}
            status={status}
            setStatus={setStatus}
            startDate={startDate}
            setStartDate={setStartDate}
            saveStyle={saveStyle}
            setSaveStyle={setSaveStyle}
            styleName={styleName}
            setStyleName={setStyleName}
            reparsing={reparsing}
            remapOpen={remapOpen}
            setRemapOpen={setRemapOpen}
            error={error}
            canConfirm={canSingleConfirm}
            onOverride={applyOverride}
            onConfirm={handleSingleConfirm}
            onReset={reset}
            setEntry={setEntry}
          />
        )}

        {/* Step: bulk review */}
        {step === 'bulk' && (
          <div className="space-y-3">
            {entries.some((e) => e.include && isImportable(e) && e.preview?.layoutTemplate) && (
              <div className="space-y-2 rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={saveStyle} onChange={(e) => setSaveStyle(e.target.checked)} />
                  Save this program style for future programs
                </label>
                <p className="text-xs text-muted-foreground">
                  Adds these sheets’ layout (colors, columns, day labels) to your style library so new
                  programs can reuse the look. One style is saved for the batch.
                </p>
                {saveStyle && (
                  <input
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="Style name (defaults to the first program)"
                    value={styleName}
                    onChange={(e) => setStyleName(e.target.value)}
                  />
                )}
              </div>
            )}
            <BulkImportReview
              entries={entries}
              groups={groups}
              importableCount={importableCount}
              canBulkConfirm={canBulkConfirm}
              assignments={assignments}
              athletes={athletes}
              setAssignment={setAssignment}
              setEntry={setEntry}
              onReset={reset}
              onConfirm={handleBulkConfirm}
            />
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
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
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
