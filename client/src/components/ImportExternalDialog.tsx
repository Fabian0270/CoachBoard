import { useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Upload, Loader2, AlertTriangle, XCircle } from 'lucide-react'
import type { ExternalImportPreview, ExternalColumnMapping } from 'coachboard-shared'

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
}

type Step = 'pick' | 'previewing' | 'preview'

export default function ImportExternalDialog({ open, onOpenChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('pick')
  const [preview, setPreview] = useState<ExternalImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setStep('pick')
    setPreview(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleClose(open: boolean) {
    if (!open) reset()
    onOpenChange(open)
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
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
      setPreview(data as ExternalImportPreview)
      setStep('preview')
    } catch {
      setError('Failed to reach server')
      setStep('pick')
    }
  }

  const hasErrors = preview && preview.errors.length > 0
  const hasWarnings = preview && preview.warnings.length > 0

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
              preview — nothing is saved yet.
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
              </div>
            ) : (
              <>
                <p className="text-sm">
                  Detected <strong>{preview.weeks}</strong> week{preview.weeks !== 1 ? 's' : ''} ×{' '}
                  <strong>{preview.days}</strong> day-block{preview.days !== 1 ? 's' : ''},{' '}
                  <strong>{preview.exerciseCount}</strong> exercise{preview.exerciseCount !== 1 ? 's' : ''}.
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
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={reset}>Choose another file</Button>
              <Button onClick={() => handleClose(false)}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
