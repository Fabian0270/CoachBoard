import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Upload, Loader2, AlertTriangle, XCircle, Check } from 'lucide-react'
import type { ExternalImportPreview, ExternalColumnMapping, SuggestionGoal } from 'coachboard-shared'

interface Athlete { id: string; name: string }

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
      {mapping.rpeFromRir && (
        <span className="text-muted-foreground"> (RIR converted to RPE)</span>
      )}
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

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (programId: string) => void
}

type Step = 'pick' | 'previewing' | 'preview' | 'finalize' | 'committing' | 'done'

const inputClass = 'w-full rounded border bg-background px-3 py-2 text-sm'

export default function ImportExternalDialog({ open, onOpenChange, onCreated }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('pick')
  const [preview, setPreview] = useState<ExternalImportPreview | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  // finalize form state
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [athleteId, setAthleteId] = useState('')
  const [name, setName] = useState('')
  const [status, setStatus] = useState('active')
  const [startDate, setStartDate] = useState(todayIso())
  const [focus, setFocus] = useState<SuggestionGoal | ''>('')

  useEffect(() => {
    if (!open) return
    fetch('/api/athletes')
      .then((r) => r.json())
      .then((data) => setAthletes(Array.isArray(data) ? data : []))
      .catch(() => setAthletes([]))
  }, [open])

  function reset() {
    setStep('pick')
    setPreview(null)
    setPendingFile(null)
    setError(null)
    setAthleteId('')
    setName('')
    setStatus('active')
    setStartDate(todayIso())
    setFocus('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleClose(open: boolean) {
    if (!open) reset()
    onOpenChange(open)
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPendingFile(file)
    // Default the program name from the filename, turning the underscores that
    // download names use ("block_2") into spaces → "block 2". Hyphens are left
    // alone since they're often intentional (e.g. "Off-Season").
    setName(file.name.replace(/\.xlsx$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim())
    setError(null)
    setStep('previewing')
    try {
      const buf = await file.arrayBuffer()
      const res = await fetch('/api/programs/import-external?dry_run=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Preview failed')
        setStep('pick')
        return
      }
      const pv = data as ExternalImportPreview
      setPreview(pv)
      // Pre-select the focus dropdown with the parser's best guess; coach confirms.
      setFocus(pv.suggestedFocus ?? '')
      setStep('preview')
    } catch {
      setError('Failed to reach server')
      setStep('pick')
    }
  }

  async function handleConfirm() {
    if (!pendingFile) return
    setError(null)
    setStep('committing')
    try {
      const buf = await pendingFile.arrayBuffer()
      const params = new URLSearchParams({ athlete_id: athleteId, name, status })
      // Archived programs don't carry a start date — server places days in order.
      if (status !== 'archived' && startDate) params.set('start_date', startDate)
      if (focus) params.set('focus', focus)
      const res = await fetch(`/api/programs/import-external?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Import failed')
        setStep('finalize')
        return
      }
      setStep('done')
      onCreated(data.programId)
    } catch {
      setError('Failed to reach server')
      setStep('finalize')
    }
  }

  const hasErrors = preview && preview.errors.length > 0
  const hasWarnings = preview && preview.warnings.length > 0
  const canConfirm = athleteId !== '' && name.trim() !== '' && (status === 'archived' || startDate !== '')

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import external program</DialogTitle>
        </DialogHeader>

        {/* Step: pick file */}
        {(step === 'pick' || step === 'previewing') && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload an Excel program built outside CoachBoard. We'll detect its structure and show a
              preview before anything is saved.
            </p>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={step === 'previewing'}>
                {step === 'previewing'
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analysing…</>
                  : <><Upload className="h-4 w-4 mr-2" />Choose file</>}
              </Button>
              <span className="text-sm text-muted-foreground">
                {step === 'previewing' ? 'Reading sheet…' : '.xlsx only'}
              </span>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileChange} />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {/* Step: preview */}
        {step === 'preview' && preview && (
          <div className="space-y-4">
            {hasErrors ? (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-1 text-destructive">
                  <XCircle className="h-4 w-4" />
                  This file can't be imported
                </h3>
                <ul className="text-sm text-muted-foreground space-y-0.5 list-disc list-inside">
                  {preview.errors.map((err, i) => <li key={i}>{err}</li>)}
                </ul>
                <ColumnMapping mapping={preview.columnMapping} />
                <div className="flex justify-end pt-2">
                  <Button variant="outline" onClick={reset}>Choose another file</Button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm">
                  Detected <strong>{preview.weeks}</strong> week{preview.weeks !== 1 ? 's' : ''} ×{' '}
                  <strong>{preview.days}</strong> day-block{preview.days !== 1 ? 's' : ''},{' '}
                  <strong>{preview.exerciseCount}</strong> exercise{preview.exerciseCount !== 1 ? 's' : ''}.
                  <span className="text-muted-foreground">
                    {' '}Layout: {
                      preview.layout === 'horizontal' ? 'weeks across columns'
                        : preview.layout === 'block-grid' ? 'week blocks with day sections'
                        : preview.layout === 'week-grid' ? 'week blocks with weekday sections'
                        : 'stacked sections'
                    }.
                  </span>
                </p>
                <ColumnMapping mapping={preview.columnMapping} />

                {hasWarnings && (
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold flex items-center gap-1 text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {preview.warnings.length} warning{preview.warnings.length !== 1 ? 's' : ''}
                    </h3>
                    <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                      {preview.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
                    </ul>
                  </div>
                )}

                {preview.exercises.length > 0 && <ExerciseTable preview={preview} />}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={reset}>Choose another file</Button>
                  <Button onClick={() => setStep('finalize')} disabled={preview.exerciseCount === 0}>
                    Continue →
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step: finalize */}
        {step === 'finalize' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Set up the program. Days are placed in order starting from the Monday of the chosen week.
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">Athlete</label>
                <select className={inputClass} value={athleteId} onChange={(e) => setAthleteId(e.target.value)}>
                  <option value="">Select an athlete…</option>
                  {athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Program name</label>
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
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
                <select className={inputClass} value={focus} onChange={(e) => setFocus(e.target.value as SuggestionGoal | '')}>
                  <option value="">Unclassified</option>
                  <option value="hypertrophy">Hypertrophy</option>
                  <option value="strength">Strength</option>
                  <option value="peaking">Peaking</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {preview?.suggestedFocus
                    ? 'Pre-filled from the program’s rep ranges — helps tailor future suggestions.'
                    : 'Labels this program so suggestions can learn your style.'}
                </p>
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep('preview')}>← Back</Button>
              <Button onClick={handleConfirm} disabled={!canConfirm}>Create program</Button>
            </div>
          </div>
        )}

        {/* Step: committing */}
        {step === 'committing' && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Creating program…</span>
          </div>
        )}

        {/* Step: done */}
        {step === 'done' && (
          <div className="flex items-center gap-3 py-4 text-green-600">
            <Check className="h-5 w-5" />
            <span className="text-sm font-medium">Program created — opening it now…</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
