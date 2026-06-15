import { useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Upload, Loader2, AlertTriangle, Check } from 'lucide-react'
import type { ImportPreview, E1RMEstimate } from 'coachboard-shared'

function E1RMTable({ estimates }: { estimates: E1RMEstimate[] }) {
  if (estimates.length === 0) return null
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">Estimated 1RM (last week per lift)</h3>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium">Lift</th>
              <th className="px-3 py-2 text-center font-medium">Week</th>
              <th className="px-3 py-2 text-center font-medium">Result</th>
              <th className="px-3 py-2 text-center font-medium">Est. 1RM</th>
            </tr>
          </thead>
          <tbody>
            {estimates.map((est, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="px-3 py-2 font-medium">{est.liftName}</td>
                <td className="px-3 py-2 text-center text-muted-foreground">W{est.weekIndex + 1}</td>
                <td className="px-3 py-2 text-center text-muted-foreground font-mono text-xs">
                  {est.weight} kg × {est.reps} @ RPE {est.rpe}
                </td>
                <td className="px-3 py-2 text-center font-mono font-semibold">
                  ~{est.e1rm} kg
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  programId: string
  onImported: () => void
}

type Step = 'pick' | 'previewing' | 'preview' | 'committing' | 'done'

export default function ImportDialog({ open, onOpenChange, programId, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('pick')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedCount, setUpdatedCount] = useState<number | null>(null)

  function reset() {
    setStep('pick')
    setPreview(null)
    setPendingFile(null)
    setError(null)
    setUpdatedCount(null)
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
    setError(null)
    setStep('previewing')
    try {
      const buf = await file.arrayBuffer()
      const res = await fetch(`/api/programs/${programId}/import?dry_run=1`, {
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
      setPreview(data as ImportPreview)
      setStep('preview')
    } catch {
      setError('Failed to reach server')
      setStep('pick')
    }
  }

  async function handleConfirm() {
    if (!pendingFile || !preview) return
    setStep('committing')
    setError(null)
    try {
      const buf = await pendingFile.arrayBuffer()
      const res = await fetch(`/api/programs/${programId}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Import failed')
        setStep('preview')
        return
      }
      setUpdatedCount(data.updatedCount ?? preview.matched.length)
      setStep('done')
      onImported()
    } catch {
      setError('Failed to reach server')
      setStep('preview')
    }
  }

  const matchCount = preview?.matched.length ?? 0
  const hasMatches = matchCount > 0
  const hasWarnings = preview && preview.warnings.length > 0
  const hasE1rm = preview && preview.e1rmEstimates.length > 0

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import results from Excel</DialogTitle>
        </DialogHeader>

        {/* Step: pick file */}
        {(step === 'pick' || step === 'previewing') && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select the filled-in xlsx file the athlete returned. Load Used and Last Set RPE
              values will be read and shown for your review before anything is saved.
            </p>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => fileRef.current?.click()}
                disabled={step === 'previewing'}
              >
                {step === 'previewing'
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analysing…</>
                  : <><Upload className="h-4 w-4 mr-2" />Choose file</>}
              </Button>
              <span className="text-sm text-muted-foreground">
                {step === 'previewing' ? 'Reading sheet…' : '.xlsx only'}
              </span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={handleFileChange}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {/* Step: preview */}
        {step === 'preview' && preview && (
          <div className="space-y-4">
            {!hasMatches && !hasWarnings && (
              <p className="text-sm text-muted-foreground">
                No filled-in Load Used or RPE values were found in the sheet.
              </p>
            )}

            {hasMatches && !hasE1rm && (
              <p className="text-sm text-muted-foreground">
                {matchCount} value{matchCount !== 1 ? 's' : ''} ready to import. No main lifts (Squat, Bench, Deadlift) with weight and RPE found for 1RM estimation.
              </p>
            )}

            {hasE1rm && <E1RMTable estimates={preview.e1rmEstimates} />}

            {hasWarnings && (
              <div className="space-y-1">
                <h3 className="text-sm font-semibold flex items-center gap-1 text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {preview.warnings.length} warning{preview.warnings.length !== 1 ? 's' : ''}
                </h3>
                <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { reset() }}>
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={!hasMatches}>
                Confirm import
              </Button>
            </div>
          </div>
        )}

        {/* Step: committing */}
        {step === 'committing' && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Saving results…</span>
          </div>
        )}

        {/* Step: done */}
        {step === 'done' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-green-600">
              <Check className="h-5 w-5" />
              <span className="text-sm font-medium">
                {updatedCount} exercise{updatedCount !== 1 ? 's' : ''} updated — program marked as completed.
              </span>
            </div>
            {preview && hasE1rm && <E1RMTable estimates={preview.e1rmEstimates} />}
            <div className="flex justify-end">
              <Button onClick={() => handleClose(false)}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
