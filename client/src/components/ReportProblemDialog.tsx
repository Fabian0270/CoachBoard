import { useEffect, useState } from 'react'
import { Loader2, Send, Download } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { useToast } from './ui/toast'
import { errorMessage, getJson } from '../lib/api'

// ---------------------------------------------------------------------------
// "Report a problem" (S4, D81–D83). The coach writes what happened, sees
// exactly what goes in, and sends it to support over their own email — or,
// without email set up, saves the same .zip and sends it themselves.
// ---------------------------------------------------------------------------

interface Preview { version: string | null; os: string; logBytes: number; emailConfigured: boolean; supportAddress: string }

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** The file as base64, read as a data URL (which every runtime here supports). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

export default function ReportProblemDialog({
  open,
  onOpenChange,
  file = null,
  initialDescription = '',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The file that failed to import, offered as an attachment (D83). */
  file?: File | null
  initialDescription?: string
}) {
  const toast = useToast()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [description, setDescription] = useState(initialDescription)
  const [includeFile, setIncludeFile] = useState(true)
  const [busy, setBusy] = useState<'send' | 'save' | null>(null)

  useEffect(() => {
    if (!open) return
    setDescription(initialDescription)
    setIncludeFile(true)
    setError(null)
    getJson<Preview>('/api/support/report').then(setPreview).catch((e) => setError(errorMessage(e)))
  }, [open, initialDescription])

  const body = async () => ({
    description,
    file: file && includeFile ? { name: file.name, base64: await toBase64(file) } : null,
  })

  const save = async () => {
    setBusy('save')
    try {
      const res = await fetch('/api/support/report/zip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await body()),
      })
      if (!res.ok) throw new Error(`the server said ${res.status}`)
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'coachboard-report.zip'
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Saved ${name}. Email it to ${preview?.supportAddress ?? 'support'}.`)
      onOpenChange(false)
    } catch (e) {
      toast.error(`Could not save the report. ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const send = async () => {
    setBusy('send')
    try {
      const res = await fetch('/api/support/report/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await body()),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `the server said ${res.status}`)
      }
      toast.success('Report sent. Thank you — you will get an answer by email.')
      onOpenChange(false)
    } catch (e) {
      toast.error(`Could not send the report. ${errorMessage(e)} You can save it instead.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>Tell what you were doing and what went wrong. The app adds what helps to find it.</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="What happened"
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Importing my block from Excel said it found no Sets column, but the sheet has one."
        />
        {error ? (
          <p className="text-sm text-destructive">Could not prepare the report. {error}</p>
        ) : !preview ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-1 text-sm">
            <p className="font-medium">What goes in</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              <li>What you wrote above</li>
              <li>CoachBoard {preview.version ?? '(version unknown)'} on {preview.os}</li>
              <li>The end of the app’s log ({kb(preview.logBytes)}) — what the app did and any errors</li>
              {file && (
                <li className="list-none -ml-5">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={includeFile} onChange={(e) => setIncludeFile(e.target.checked)} />
                    The file that failed: {file.name}
                  </label>
                </li>
              )}
            </ul>
            <p className="text-xs text-muted-foreground">Not your database: no athletes, programs or payments beyond what the log mentions.</p>
            <p className="pt-1 text-xs text-muted-foreground">
              {preview.emailConfigured
                ? `Sent from your email to ${preview.supportAddress}.`
                : `Email isn’t set up in CoachBoard, so the report is saved as a .zip for you to email to ${preview.supportAddress}.`}
            </p>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={!!busy}>Cancel</Button>
          <Button variant={preview?.emailConfigured ? 'outline' : 'default'} size="sm" onClick={() => void save()} disabled={!!busy || !preview}>
            {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Save as .zip
          </Button>
          {preview?.emailConfigured && (
            <Button size="sm" onClick={() => void send()} disabled={!!busy}>
              {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send report
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
